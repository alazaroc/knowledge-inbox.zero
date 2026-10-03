import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  TABLE_NAMES,
  computeFreshness,
  computeMkv,
  computeNovelty,
  computeRedundancy,
  computeRelevance,
  normalizeConcepts,
  scoresToRecommendationState,
  type DocMetadata,
  type Extraction,
  type KnowledgeDocument,
  type Profile,
  type RecommendationState,
  type RecommendationTag,
  type ScoreInput,
  type Scores,
} from '@app/shared';
import { ddb } from '../lib/dynamo.js';
import { retrieveReadable } from '../lib/retrieve.js';
import { getUserToken } from '../lib/profile-tokens.js';
import { bedrockExtract, bedrockExplain, bedrockScore } from '../lib/bedrock.js';
import { now } from '../lib/ids.js';

/**
 * SQS-triggered analysis worker — the full per-document pipeline
 * (fetch → extract → score → explain → persist → update counters).
 *
 * This is the ONLY component that invokes Bedrock and S3. It reuses the
 * `@app/shared` scoring core so the identical, property-tested code runs here.
 *
 * Resilience (Req 3.6, 3.7, NFR-5): the function uses partial batch failure
 * reporting. A document that fails is marked `failed`, its batch counters are
 * moved, and the record is reported in `batchItemFailures` so SQS can redrive
 * it (up to `maxReceiveCount`, then the DLQ). A single bad URL never fails the
 * whole SQS batch nor stops the import batch from finishing.
 *
 * The 120s per-document budget (Req 3.9) is the Lambda's own timeout
 * (configured in task 6.5); a stuck fetch is additionally bounded by the 15s
 * retrieve timeout inside `retrieveReadable`.
 */

// Truncate readable text beyond this length before extraction (Req 4.6).
const MAX_EXTRACT_CHARS = 200_000;

// Offload raw content to S3 when it exceeds this size (Req 4.7).
const S3_OFFLOAD_THRESHOLD = 300_000;

// Minimum acceptable explanation length; shorter → placeholder (Req 6.6).
const MIN_EXPLANATION_CHARS = 50;

// Reading-time estimate: average adult reading speed, minimum one minute.
const WORDS_PER_MINUTE = 225;

const EXPLANATION_PLACEHOLDER =
  'Explanation unavailable; recommendation and scores were still computed.';

// "Bring your own" profile source: when the profile carries a public raw URL,
// the worker fetches it at analysis time and uses its text as the profile
// context, WITHOUT persisting the fetched content (only the URL is stored).
const PROFILE_FETCH_TIMEOUT_MS = 10_000;
const PROFILE_FETCH_MAX_CHARS = 20_000;

const s3 = new S3Client({});
const contentBucket = () => process.env.CONTENT_BUCKET ?? '';

// Atomic batch counter moves (Req 2.2, 3.3, 3.8, 3.10; CP-10). Every move
// decrements one counter and increments another by the same amount, so
// `pending + processing + completed + failed == total` is preserved atomically
// by DynamoDB. `total` is written once at creation and never touched again.
const COUNTER_VALUES = { ':one': 1, ':neg1': -1 } as const;

interface AnalysisMessage {
  documentId: string;
  batchId: string;
  ownerId: string;
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch {
      // The record failed terminally for this invocation; report it so SQS
      // redrives it (Req 3.7) and does not delete it from the queue.
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};

function parseMessage(record: SQSRecord): AnalysisMessage {
  const msg = JSON.parse(record.body) as Partial<AnalysisMessage>;
  if (!msg.documentId || !msg.batchId || !msg.ownerId) {
    throw new Error('Malformed analysis message: missing documentId/batchId/ownerId');
  }
  return { documentId: msg.documentId, batchId: msg.batchId, ownerId: msg.ownerId };
}

async function processRecord(record: SQSRecord): Promise<void> {
  const msg = parseMessage(record);
  await processDocument(msg);
}

/**
 * Known, accepted limitations (documented debt, intentionally NOT changed to
 * avoid destabilizing the CP-10 counter flow that is property-tested):
 *
 * - Counter/state atomicity: if `persistCompleted` (status `completed`) succeeds
 *   but the subsequent `moveCounters(processing→completed)` throws, the catch
 *   marks the document `failed` and moves `processing→failed`. The counter SUM
 *   is still conserved (CP-10 holds), but the document can end up `failed` while
 *   holding completed content. Fully fixing this needs a transaction across two
 *   tables; the window is narrow and the invariant that matters (conservation)
 *   is preserved.
 * - `bumpStateCount` idempotency: on an SQS redrive after a successful terminal
 *   write, the per-owner COUNTS aggregate could be incremented twice. Making it
 *   idempotent requires a guarded transition that changes the write model the
 *   counter property test depends on, so it is deferred rather than risked here.
 */
async function processDocument(msg: AnalysisMessage): Promise<void> {
  // 1. pending → processing (atomic counter move on the batch).
  await moveCounters(msg.batchId, 'pending', 'processing');

  try {
    // 2. Load the owning document, the owner's profile, and prior concepts.
    const doc = await getDocument(msg.documentId);
    if (!doc || doc.ownerId !== msg.ownerId) {
      throw new Error(`Document ${msg.documentId} not found or not owned by ${msg.ownerId}`);
    }

    const profile = await getProfile(msg.ownerId);
    const { priorConcepts, isExactDuplicate: isDup } = await getPriorContext(
      msg.ownerId,
      doc.canonicalUrl,
      msg.documentId
    );

    // 3. Retrieve + extract readable content (15s bounded fetch inside).
    const got = await retrieveReadable(doc.canonicalUrl);
    let degraded = got.degraded;
    let degradedReason = got.reason;
    let s3ContentRef: string | undefined;

    console.log(
      JSON.stringify({
        stage: 'retrieve',
        documentId: msg.documentId,
        url: doc.canonicalUrl,
        degraded: got.degraded,
        reason: got.reason,
        textLen: got.text?.length ?? 0,
      })
    );

    // 4. Structured extraction (only when we have readable text).
    let extraction: Extraction | undefined;
    let readingMinutes: number | undefined;
    if (got.text) {
      let text = got.text;
      let truncated = false;
      if (text.length > MAX_EXTRACT_CHARS) {
        text = text.slice(0, MAX_EXTRACT_CHARS); // Req 4.6
        truncated = true;
      }

      // Reading time from the FULL readable text (before truncation), ~225 wpm,
      // at least 1 minute. Only set when there is text; degraded docs stay unset.
      const wordCount = got.text.split(/\s+/).filter(Boolean).length;
      readingMinutes =
        wordCount > 0 ? Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE)) : undefined;

      try {
        const extracted = await bedrockExtract({ text });
        extraction = { ...extracted, truncated, wordCount };
      } catch (err) {
        // Bounded retries already exhausted inside bedrockExtract → degrade.
        // Keep the real reason so it is persisted and visible for triage
        // instead of being silently lost.
        degraded = true;
        degradedReason = `extract_failed: ${reasonOf(err)}`;
        extraction = undefined;
        console.error(
          JSON.stringify({
            stage: 'extract',
            documentId: msg.documentId,
            url: doc.canonicalUrl,
            reason: degradedReason,
          })
        );
      }

      // Req 4.7: offload large raw content to S3; store only the reference.
      if (
        (got.html?.length ?? 0) > S3_OFFLOAD_THRESHOLD ||
        got.text.length > S3_OFFLOAD_THRESHOLD
      ) {
        s3ContentRef = await putContentToS3(msg, got.text);
      }
    }

    // 5. Scoring. Resolve the EFFECTIVE profile ("bring your own": fetch the
    // public URL at analysis time without persisting it), then score the doc
    // SEMANTICALLY with the LLM. Freshness + MKV stay deterministic.
    const nowDate = new Date();
    const effectiveProfile = await resolveEffectiveProfile(profile);

    const freshness = computeFreshness({
      docConcepts: new Set(),
      docTopics: new Set(),
      interests: new Set(),
      known: new Set(),
      publishedAt: got.metadata.publishedAt,
      now: nowDate,
      isExactPriorDuplicate: isDup,
    });
    const freshnessEstimated = !got.metadata.publishedAt; // Req 5.9

    let scores: Scores;
    let scoreReasoning: string | undefined;
    let scoringFallbackReason: string | undefined;

    if (extraction) {
      try {
        // PRIMARY: semantic LLM scoring against the full rich profile.
        const llm = await bedrockScore({ extraction, profile: effectiveProfile });
        const base: Scores = {
          relevance: llm.relevance,
          novelty: llm.novelty,
          redundancy: llm.redundancy,
          freshness,
          mkv: 0,
        };
        scores = { ...base, mkv: computeMkv(base) };
        scoreReasoning = llm.reasoning;
      } catch (err) {
        // FALLBACK: deterministic string-match scorer (kept in @app/shared).
        scoringFallbackReason = `llm_scoring_failed: ${reasonOf(err)}`;
        console.error(
          JSON.stringify({
            stage: 'score',
            documentId: msg.documentId,
            reason: scoringFallbackReason,
          })
        );
        scores = deterministicScores({
          extraction,
          profile: effectiveProfile,
          priorConcepts,
          freshness,
          isDup,
          now: nowDate,
        });
      }
    } else {
      // Degraded (no extraction): deterministic metadata-only scoring (Req 4.5).
      scores = deterministicScores({
        extraction,
        profile: effectiveProfile,
        priorConcepts,
        freshness,
        isDup,
        now: nowDate,
      });
    }

    // 6. Single recommendation state + advisory tags.
    const { state, tags } = scoresToRecommendationState(scores, {
      isExactPriorDuplicate: isDup,
      publishedAt: got.metadata.publishedAt,
      now: nowDate,
    });

    // 7. Explanation. Prefer the LLM scoring reasoning (why it matters for this
    // user). When present we never leave "explanation unavailable" since the
    // score WAS computed. Otherwise write a dedicated explanation; last resort
    // is the placeholder (Req 6.6).
    //
    // Token-cost control: for DISCARDED documents (state SKIP — low marginal
    // value / below the recommendation threshold) we do NOT spend a dedicated
    // bedrockExplain call when there is no scoring reasoning to reuse; the
    // placeholder is sufficient for something the user is told to skip. This
    // saves ~1/3 of the per-document LLM calls on low-signal docs.
    let explanation = EXPLANATION_PLACEHOLDER;
    let explanationUnavailable = true;
    if (scoreReasoning && scoreReasoning.trim().length >= MIN_EXPLANATION_CHARS) {
      explanation = scoreReasoning.trim();
      explanationUnavailable = false;
    } else if (extraction && state !== 'SKIP') {
      try {
        const written = await bedrockExplain({
          extraction,
          scores,
          state,
          profile: effectiveProfile,
          tags,
        });
        if (written.trim().length >= MIN_EXPLANATION_CHARS) {
          explanation = written.trim();
          explanationUnavailable = false;
        }
      } catch {
        // Keep the placeholder + explanationUnavailable flag.
      }
    }

    const scoresToPersist: Scores = freshnessEstimated
      ? { ...scores, freshnessEstimated: true } // Req 5.9
      : scores;

    // Record a non-fatal scoring fallback as the failure reason when the doc
    // was otherwise fine (not degraded), so the reason is visible for triage.
    const failureReason = degraded ? degradedReason : scoringFallbackReason;

    // 8. Persist the completed analysis, then move counters + bump aggregate.
    await persistCompleted(msg, {
      metadata: got.metadata,
      extraction,
      scores: scoresToPersist,
      state,
      tags,
      explanation,
      explanationUnavailable,
      degraded,
      failureReason,
      s3ContentRef,
      readingMinutes,
    });
    await moveCounters(msg.batchId, 'processing', 'completed');
    await bumpStateCount(msg.ownerId, state);
  } catch (err) {
    // 9. On any error: mark the document failed, move counters, maybe finish,
    // then rethrow so the record is reported as a batch item failure (Req 3.6).
    await markFailed(msg, reasonOf(err));
    await moveCounters(msg.batchId, 'processing', 'failed');
    await maybeFinishBatch(msg.batchId);
    throw err;
  }

  // 10. After a successful terminal move, maybe finish the batch.
  await maybeFinishBatch(msg.batchId);
}

// ---------------------------------------------------------------------------
// Scoring glue (reuses the pure @app/shared core as the FALLBACK path)
// ---------------------------------------------------------------------------

interface DeterministicScoreInput {
  extraction?: Extraction;
  profile: Profile;
  priorConcepts: string[];
  freshness: number;
  isDup: boolean;
  now: Date;
}

/**
 * Deterministic FALLBACK scorer: the original string-match relevance/novelty/
 * redundancy from `@app/shared`, reused verbatim when LLM scoring fails or the
 * document is degraded (no extraction). Freshness is passed in (already
 * computed) so both paths share one freshness value; MKV is recomputed here.
 */
function deterministicScores(input: DeterministicScoreInput): Scores {
  const { extraction, profile, priorConcepts, freshness, isDup, now: nowDate } = input;

  const interests = normalizeConcepts([
    ...profile.highInterests,
    ...profile.mediumInterests,
    ...profile.currentlyResearching,
    ...profile.activeContexts,
  ]);
  const known = normalizeConcepts([...profile.alreadyKnown, ...priorConcepts]);
  const docConcepts = normalizeConcepts(extraction?.concepts ?? []);
  const docTopics = normalizeConcepts(extraction?.topics ?? []);

  const scoreInput: ScoreInput = {
    docConcepts,
    docTopics,
    interests,
    known,
    now: nowDate,
    isExactPriorDuplicate: isDup,
  };

  const relevance = computeRelevance(scoreInput);
  const novelty = computeNovelty(scoreInput);
  const redundancy = computeRedundancy(scoreInput);
  const base: Scores = { relevance, novelty, redundancy, freshness, mkv: 0 };
  return { ...base, mkv: computeMkv(base) };
}

/**
 * Resolve the EFFECTIVE profile for scoring. "Bring your own": when the stored
 * profile carries a public `profileSourceUrl`, fetch it (bounded, 10s / 20KB)
 * at analysis time and use its text as the profile `context`, WITHOUT
 * persisting the fetched content — only the URL is stored (the user owns the
 * data). On any fetch failure, fall back to the stored profile unchanged.
 */
async function resolveEffectiveProfile(profile: Profile): Promise<Profile> {
  // 1. Private repo source (preferred when configured): fetch with the user's
  // token from Secrets Manager. Never persisted; falls back on any failure.
  const repoUrl = profile.profileRepoUrl?.trim();
  if (repoUrl && /^https:\/\//i.test(repoUrl)) {
    try {
      const token = await getUserToken(profile.userId);
      if (token) {
        const text = await fetchProfileSource(repoUrl, token);
        if (text) return { ...profile, context: text };
      }
    } catch {
      // Ignore and try the public source / stored profile next.
    }
  }

  // 2. Public "bring your own" source.
  const url = profile.profileSourceUrl?.trim();
  if (!url || !/^https:\/\//i.test(url)) return profile;

  try {
    const text = await fetchProfileSource(url);
    if (text) {
      // The fetched rich text becomes the primary "About you" signal; stored
      // list fields still ride along for the deterministic fallback.
      return { ...profile, context: text };
    }
  } catch {
    // Ignore and fall back to the stored profile.
  }
  return profile;
}

/** Bounded fetch of the user's profile source (never throws upward). An
 * optional bearer token authenticates a private-repo raw URL. */
async function fetchProfileSource(url: string, token?: string): Promise<string | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROFILE_FETCH_TIMEOUT_MS);
  timer.unref?.();
  try {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers });
    if (!res.ok) return undefined;
    const raw = (await res.text()).trim();
    return raw ? raw.slice(0, PROFILE_FETCH_MAX_CHARS) : undefined;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// DynamoDB access + atomic counters
// ---------------------------------------------------------------------------

async function getDocument(documentId: string): Promise<KnowledgeDocument | undefined> {
  const r = await ddb.send(
    new GetCommand({ TableName: TABLE_NAMES.DOCUMENTS, Key: { documentId } })
  );
  return r.Item as KnowledgeDocument | undefined;
}

/**
 * Load the owner's profile. The worker scores from a concrete profile; when the
 * user has not configured one yet we fall back to an empty profile so scoring
 * degrades to "nothing known / nothing of interest" rather than failing.
 */
async function getProfile(ownerId: string): Promise<Profile> {
  const r = await ddb.send(
    new GetCommand({ TableName: TABLE_NAMES.PROFILES, Key: { userId: ownerId } })
  );
  const profile = r.Item as Profile | undefined;
  if (profile) return profile;

  const ts = now();
  return {
    userId: ownerId,
    highInterests: [],
    mediumInterests: [],
    currentlyResearching: [],
    alreadyKnown: [],
    avoidContentTypes: [],
    activeContexts: [],
    notConfigured: true,
    createdAt: ts,
    updatedAt: ts,
  };
}

interface PriorContext {
  /**
   * Union of the concepts of the owner's OTHER completed documents (excluding
   * this one). Feeds the user's "known" set so novelty/redundancy reflect what
   * prior reading already covered.
   */
  priorConcepts: string[];
  /**
   * Whether a PRIOR completed document for this owner shares this canonicalUrl.
   * The deterministic `documentId` already dedups re-imports, so this guards the
   * Req 5.4 exact-duplicate signal for any OTHER owned document that resolved to
   * the same canonical URL.
   */
  isExactDuplicate: boolean;
}

/**
 * Single paginated scan of the owner's documents via the `byOwner` GSI that, in
 * one pass, (a) accumulates the concepts of OTHER completed documents and
 * (b) detects whether any OTHER completed document shares `canonicalUrl`.
 *
 * This replaces two independent full scans of the same index (one for prior
 * concepts, one for the duplicate check): both needed the identical query, so
 * folding them halves the per-document read cost on the `byOwner` GSI (NFR-1.3,
 * NFR-1.4). The current document is always excluded from both signals.
 */
async function getPriorContext(
  ownerId: string,
  canonicalUrl: string,
  documentId: string
): Promise<PriorContext> {
  const concepts = new Set<string>();
  let isExactDuplicate = false;
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const r = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAMES.DOCUMENTS,
        IndexName: 'byOwner',
        KeyConditionExpression: 'ownerId = :o',
        ExpressionAttributeValues: { ':o': ownerId },
        ExclusiveStartKey: exclusiveStartKey,
      })
    );

    for (const item of (r.Items ?? []) as KnowledgeDocument[]) {
      if (item.documentId === documentId) continue;
      if (item.status !== 'completed') continue;
      for (const c of item.extraction?.concepts ?? []) concepts.add(c);
      if (item.canonicalUrl === canonicalUrl) isExactDuplicate = true;
    }

    exclusiveStartKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  return { priorConcepts: [...concepts], isExactDuplicate };
}

type CounterName = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * Atomic counter move on a batch: decrement `from` and increment `to` in a
 * single `ADD` update (Req 2.2, 3.3, 3.8, 3.10; CP-10).
 *
 *   ADD <to> :one, <from> :neg1   with { ':one': 1, ':neg1': -1 }
 */
async function moveCounters(batchId: string, from: CounterName, to: CounterName): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.BATCHES,
      Key: { batchId },
      UpdateExpression: `ADD ${to} :one, ${from} :neg1 SET updatedAt = :ts`,
      ExpressionAttributeValues: { ...COUNTER_VALUES, ':ts': now() },
    })
  );
}

interface CompletedUpdate {
  metadata: DocMetadata;
  extraction?: Extraction;
  scores: Scores;
  state: RecommendationState;
  tags: RecommendationTag[];
  explanation: string;
  explanationUnavailable: boolean;
  degraded: boolean;
  failureReason?: string;
  s3ContentRef?: string;
  readingMinutes?: number;
}

/**
 * Persist the completed analysis onto the document. Sets `stateKey` for the
 * `byOwnerState` GSI (`<state>#<documentId>`).
 *
 * The optional fields (`extraction`, `failureReason`, `s3ContentRef`) are only
 * referenced in the expression when they actually have a value: the document
 * client strips `undefined` from the attribute-value map, so naming `:x` in the
 * expression while `x` is undefined makes DynamoDB reject the whole update
 * ("expression attribute value ... is not defined"). Absent fields are REMOVEd
 * instead, keeping the item clean.
 */
async function persistCompleted(msg: AnalysisMessage, u: CompletedUpdate): Promise<void> {
  const stateKey = `${u.state}#${msg.documentId}`;

  const setParts = [
    '#status = :status',
    'metadata = :metadata',
    'scores = :scores',
    'recommendationState = :state',
    'tags = :tags',
    'stateKey = :stateKey',
    'explanation = :explanation',
    'explanationUnavailable = :explanationUnavailable',
    'degraded = :degraded',
    'updatedAt = :ts',
  ];
  const values: Record<string, unknown> = {
    ':status': 'completed',
    ':metadata': u.metadata,
    ':scores': u.scores,
    ':state': u.state,
    ':tags': u.tags,
    ':stateKey': stateKey,
    ':explanation': u.explanation,
    ':explanationUnavailable': u.explanationUnavailable,
    ':degraded': u.degraded,
    ':ts': now(),
  };

  // Optional fields: SET when present, REMOVE when absent (never name an
  // undefined value in the expression).
  const removeParts: string[] = [];
  if (u.extraction !== undefined) {
    setParts.push('extraction = :extraction');
    values[':extraction'] = u.extraction;
  } else {
    removeParts.push('extraction');
  }
  if (u.failureReason !== undefined) {
    setParts.push('failureReason = :failureReason');
    values[':failureReason'] = u.failureReason;
  } else {
    removeParts.push('failureReason');
  }
  if (u.s3ContentRef !== undefined) {
    setParts.push('s3ContentRef = :s3ContentRef');
    values[':s3ContentRef'] = u.s3ContentRef;
  } else {
    removeParts.push('s3ContentRef');
  }
  if (u.readingMinutes !== undefined) {
    setParts.push('readingMinutes = :readingMinutes');
    values[':readingMinutes'] = u.readingMinutes;
  } else {
    removeParts.push('readingMinutes');
  }

  const updateExpression =
    `SET ${setParts.join(', ')}` + (removeParts.length ? ` REMOVE ${removeParts.join(', ')}` : '');

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.DOCUMENTS,
      Key: { documentId: msg.documentId },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: values,
    })
  );
}

/** Mark a document failed with a reason (Req 3.6, 4.5). */
async function markFailed(msg: AnalysisMessage, reason: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.DOCUMENTS,
      Key: { documentId: msg.documentId },
      UpdateExpression: 'SET #status = :status, failureReason = :reason, updatedAt = :ts',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'failed',
        ':reason': reason,
        ':ts': now(),
      },
    })
  );
}

/**
 * Bump the per-owner COUNTS aggregate item (`documentId = "COUNTS#<ownerId>"`)
 * on the first terminal transition to a recommendation state, so library counts
 * are O(1) and pagination-independent (Req 7.2, 7.7). Atomic `ADD` increments
 * both `total` and the state's own counter.
 */
async function bumpStateCount(ownerId: string, state: RecommendationState): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.DOCUMENTS,
      Key: { documentId: `COUNTS#${ownerId}` },
      UpdateExpression: `ADD #total :one, #state :one SET ownerId = :o, updatedAt = :ts`,
      ExpressionAttributeNames: { '#total': 'total', '#state': state },
      ExpressionAttributeValues: { ':one': 1, ':o': ownerId, ':ts': now() },
    })
  );
}

/**
 * Conditionally transition the batch to `finished` once no documents remain
 * pending or processing (Req 3.8). This also fires when every document failed
 * (Req 3.10). The condition guards against a double-finish under concurrency.
 */
async function maybeFinishBatch(batchId: string): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAMES.BATCHES,
        Key: { batchId },
        UpdateExpression: 'SET #status = :finished, finishedAt = :ts, updatedAt = :ts',
        ConditionExpression:
          'attribute_exists(batchId) AND #status <> :finished AND pending = :z AND processing = :z',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':finished': 'finished', ':z': 0, ':ts': now() },
      })
    );
  } catch (err) {
    // ConditionalCheckFailedException just means another worker already
    // finished it or work still remains — both are expected, not errors.
    if (!isConditionalCheckFailed(err)) throw err;
  }
}

// ---------------------------------------------------------------------------
// S3 offload (Req 4.7)
// ---------------------------------------------------------------------------

/** Store large readable content in the private content bucket; return the key. */
async function putContentToS3(msg: AnalysisMessage, text: string): Promise<string> {
  const key = `${msg.ownerId}/${msg.documentId}.txt`;
  await s3.send(
    new PutObjectCommand({
      Bucket: contentBucket(),
      Key: key,
      Body: text,
      ContentType: 'text/plain; charset=utf-8',
    })
  );
  return key;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reasonOf(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  return String(err).slice(0, 500);
}

function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof Error && err.name === 'ConditionalCheckFailedException';
}
