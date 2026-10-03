import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  SendMessageBatchCommand,
  SQSClient,
  type SendMessageBatchRequestEntry,
} from '@aws-sdk/client-sqs';
import {
  DAILY_IMPORT_LIMIT_USER,
  ROLES,
  TABLE_NAMES,
  canonicalizeUrl,
  deriveDocumentId,
  importCreateSchema,
  type Batch,
  type ImportResult,
  type KnowledgeDocument,
  type RejectedEntry,
} from '@app/shared';
import { ddb } from '../lib/dynamo.js';
import { authenticate, parseBody } from '../lib/handler-utils.js';
import { badRequest, created, notFound, ok, serverError } from '../lib/response.js';
import { newId, now } from '../lib/ids.js';

/**
 * Import batches from pasted URLs, enqueue analysis, and serve batch progress.
 *
 * Purely deterministic: validate → canonicalize → dedup → create the `Batch`
 * record + new `Document`s in `pending` → enqueue one SQS message per NEW
 * document → return `201` with the batch id in well under 3 seconds (Req 3.1).
 * All fetching, LLM extraction, scoring, and explanation happen in the async
 * worker. This handler NEVER calls Bedrock.
 *
 * - POST   /imports            → create a batch (Req 2.1–2.8, 3.1, 3.2)
 * - GET    /imports/{batchId}  → batch counts + status for polling (Req 3.3, 8.11)
 * - GET    /imports            → list the caller's batches, newest first (Req 7.1)
 */

// Per-batch cap after normalization (Req 2.7).
const MAX_URLS_PER_BATCH = 500;

// One message per new document; SQS SendMessageBatch accepts up to 10 at a time.
const SQS_BATCH_SIZE = 10;

// Sentinel prefix for the per-owner per-day usage counter that shares the
// documents table (`documentId = "USAGE#<ownerId>#<yyyy-mm-dd>"`). It carries
// NO `ownerId`, so it never surfaces in the byOwner GSI / library listing, and
// no `stateKey`, so it never surfaces in byOwnerState. Reads/writes use the
// grants the imports Fn already holds on the documents table (no new GSI/grant).
const USAGE_PREFIX = 'USAGE#';

/** UTC calendar day (YYYY-MM-DD) — the quota window, same for every user. */
function usageDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function usageKey(ownerId: string): string {
  return `${USAGE_PREFIX}${ownerId}#${usageDay()}`;
}

/** New documents this owner has already enqueued today (0 when none). */
async function readUsageToday(ownerId: string): Promise<number> {
  const r = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAMES.DOCUMENTS,
      Key: { documentId: usageKey(ownerId) },
      ProjectionExpression: '#c',
      ExpressionAttributeNames: { '#c': 'count' },
    })
  );
  const count = (r.Item as { count?: number } | undefined)?.count;
  return typeof count === 'number' ? count : 0;
}

/** Atomically add `n` to today's usage counter (ADD creates the item at 0). */
async function incrementUsageToday(ownerId: string, n: number): Promise<void> {
  if (n <= 0) return;
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.DOCUMENTS,
      Key: { documentId: usageKey(ownerId) },
      UpdateExpression: 'ADD #c :n SET updatedAt = :ts',
      ExpressionAttributeNames: { '#c': 'count' },
      ExpressionAttributeValues: { ':n': n, ':ts': now() },
    })
  );
}

const sqs = new SQSClient({});
const queueUrl = () => process.env.ANALYSIS_QUEUE_URL ?? '';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const method = event.httpMethod;
    const batchId = event.pathParameters?.batchId;

    if (method === 'POST' && !batchId) return createBatch(event);
    if (method === 'GET' && batchId) return getBatch(event);
    if (method === 'GET' && !batchId) return listBatches(event);

    return badRequest('Unrecognized route');
  } catch (err) {
    return serverError(err);
  }
};

interface PlannedDoc {
  documentId: string;
  canonicalUrl: string;
  rawUrl: string;
}

async function createBatch(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const auth = await authenticate(event);
  if ('error' in auth) return auth.error;

  const body = parseBody(event, importCreateSchema);
  if ('error' in body) return body.error;

  const ownerId = auth.ctx.sub;

  // Req 2.1: normalize each line — trim, drop blank/whitespace-only lines.
  const lines = body.data.urls
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Req 2.3 / 3.2: zero non-blank lines → reject without creating a Batch.
  if (lines.length === 0) {
    return badRequest('No URLs were provided');
  }

  // Req 2.7: more than 500 lines after normalization → reject.
  if (lines.length > MAX_URLS_PER_BATCH) {
    return badRequest(`Per-batch limit of ${MAX_URLS_PER_BATCH} URLs was exceeded`);
  }

  const rejected: RejectedEntry[] = [];
  // Canonical URL → the NEW document planned for it (dedup within the submission, Req 2.6).
  const newDocsByCanonical = new Map<string, PlannedDoc>();
  // URLs accepted but reusing an existing document (within-submission or
  // already-owned duplicates) — surfaced to the UI as a "you already had N".
  let duplicates = 0;

  for (const line of lines) {
    let canonicalUrl: string;
    try {
      // Req 2.5: canonicalizeUrl prepends https:// when scheme is absent.
      canonicalUrl = canonicalizeUrl(line);
    } catch {
      // Req 2.4: invalid URL → record rejected and continue with the rest.
      rejected.push({ line, reason: 'invalid_url' });
      continue;
    }

    const documentId = deriveDocumentId(ownerId, canonicalUrl);

    // Req 2.6: within-submission duplicate → counted as accepted, no new document.
    if (newDocsByCanonical.has(canonicalUrl)) {
      duplicates += 1;
      continue;
    }

    // Req 2.8: reuse an existing owned document rather than creating a duplicate.
    const existing = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAMES.DOCUMENTS,
        Key: { documentId },
        ProjectionExpression: 'documentId',
      })
    );
    if (existing.Item) {
      duplicates += 1;
      continue; // accepted, but reuses the existing Document
    }

    newDocsByCanonical.set(canonicalUrl, { documentId, canonicalUrl, rawUrl: line });
  }

  // ── Daily quota (cost control) ─────────────────────────────────────────────
  // ADMIN is unlimited. For USER, enforce a HARD block: enqueue only up to the
  // remaining quota and return the rest as `blocked` so the user can save and
  // retry tomorrow. Quota counts NEW documents only (what drives Bedrock cost);
  // duplicates and rejected lines never consume quota.
  const isAdmin = auth.ctx.role === ROLES.ADMIN;
  const dailyLimit = isAdmin ? null : DAILY_IMPORT_LIMIT_USER;
  const usedToday = isAdmin ? 0 : await readUsageToday(ownerId);
  const remaining = dailyLimit === null ? null : Math.max(0, dailyLimit - usedToday);

  const planned = [...newDocsByCanonical.values()];
  let newDocs = planned;
  let blocked: string[] = [];
  if (remaining !== null && planned.length > remaining) {
    newDocs = planned.slice(0, remaining);
    blocked = planned.slice(remaining).map((d) => d.rawUrl);
  }

  const ts = now();
  const batchId = newId();

  // Counter semantics (Req 2.2; CP-10 — `pending+processing+completed+failed == total`):
  // only NEW documents transition through the pipeline counters, so `pending`
  // is the number of new documents enqueued and `total = pending + rejected`.
  // Duplicates / already-owned URLs are accepted but create no Document and so
  // are not tracked by the per-document counters (they would otherwise leave
  // the batch unable to ever reach `finished`).
  const pending = newDocs.length;
  const total = pending + rejected.length;
  const batch: Batch = {
    batchId,
    ownerId,
    // A batch with no pipeline documents (everything was a duplicate or got
    // blocked by quota, with no rejected lines) is already done — otherwise it
    // would sit in `processing` forever since no worker will ever advance it.
    status: total === 0 ? 'finished' : 'processing',
    total,
    pending,
    processing: 0,
    completed: 0,
    failed: 0,
    rejected,
    createdAt: ts,
    updatedAt: ts,
  };

  await ddb.send(new PutCommand({ TableName: TABLE_NAMES.BATCHES, Item: batch }));

  // Create new Document items in `pending`.
  await Promise.all(
    newDocs.map((d) => {
      const doc: KnowledgeDocument = {
        documentId: d.documentId,
        ownerId,
        batchId,
        rawUrl: d.rawUrl,
        canonicalUrl: d.canonicalUrl,
        status: 'pending',
        createdAt: ts,
        updatedAt: ts,
      };
      return ddb.send(new PutCommand({ TableName: TABLE_NAMES.DOCUMENTS, Item: doc }));
    })
  );

  // Enqueue ONE SQS message per NEW document for the async worker.
  await enqueueDocuments(batchId, ownerId, newDocs);

  // Consume quota only for NEW documents actually enqueued (ADMIN: no-op).
  if (!isAdmin && pending > 0) {
    await incrementUsageToday(ownerId, pending);
  }

  // Req 3.1: acknowledge the batch within 3s, including the daily-quota outcome
  // and any URLs the hard block left unprocessed (so the user can save them).
  const result: ImportResult = {
    batchId,
    total: batch.total,
    pending: batch.pending,
    rejected,
    dailyLimit,
    usedToday,
    remaining: remaining === null ? null : Math.max(0, remaining - pending),
    blocked,
    duplicates,
  };
  return created(result);
}

/** Enqueues one analysis message per new document (batched in groups of 10). */
async function enqueueDocuments(
  batchId: string,
  ownerId: string,
  docs: PlannedDoc[]
): Promise<void> {
  const url = queueUrl();
  if (!url || docs.length === 0) return;

  for (let i = 0; i < docs.length; i += SQS_BATCH_SIZE) {
    const slice = docs.slice(i, i + SQS_BATCH_SIZE);
    const entries: SendMessageBatchRequestEntry[] = slice.map((d, idx) => ({
      Id: String(idx),
      MessageBody: JSON.stringify({ documentId: d.documentId, batchId, ownerId }),
    }));
    await sqs.send(new SendMessageBatchCommand({ QueueUrl: url, Entries: entries }));
  }
}

async function getBatch(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const auth = await authenticate(event);
  if ('error' in auth) return auth.error;
  const batchId = event.pathParameters?.batchId;
  if (!batchId) return badRequest('Missing batchId');

  const r = await ddb.send(new GetCommand({ TableName: TABLE_NAMES.BATCHES, Key: { batchId } }));
  const batch = r.Item as Batch | undefined;
  // 404 when missing or not owned by the caller (Req 3.3, 8.11).
  if (!batch || batch.ownerId !== auth.ctx.sub) return notFound('Batch');
  return ok(batch);
}

async function listBatches(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const auth = await authenticate(event);
  if ('error' in auth) return auth.error;

  // List the caller's batches via the byOwner GSI (PK ownerId, SK createdAt),
  // newest first (Req 7.1).
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAMES.BATCHES,
      IndexName: 'byOwner',
      KeyConditionExpression: 'ownerId = :o',
      ExpressionAttributeValues: { ':o': auth.ctx.sub },
      ScanIndexForward: false,
    })
  );
  return ok({ batches: (r.Items ?? []) as Batch[] });
}
