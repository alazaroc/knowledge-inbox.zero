import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import {
  DIFFICULTY,
  type Extraction,
  type Profile,
  type RecommendationState,
  type RecommendationTag,
  type Scores,
} from '@app/shared';

// Single provider only: Amazon Bedrock on-demand. No multi-provider abstraction
// (NFR-1.2). The model id is configurable via the BEDROCK_MODEL_ID env var so the
// deployed model can change without code changes (OD stretch B4 deferred).

const client = new BedrockRuntimeClient({});

const MODEL_ID_ENV = 'BEDROCK_MODEL_ID';

const textDecoder = new TextDecoder();

/**
 * Enforced extraction output shape. Validated with Zod; a parse/validation
 * failure drives the bounded retry in {@link bedrockExtract}. Lives in the
 * backend lib (not `@app/shared`) because it is a server-only LLM contract.
 */
export const extractionResponseSchema = z.object({
  topics: z.array(z.string()).max(50),
  concepts: z.array(z.string()).max(100),
  claims: z.array(z.string()).max(50),
  difficulty: z.enum(DIFFICULTY),
  summary: z.string().max(500),
});

export type ExtractionResponse = z.infer<typeof extractionResponseSchema>;

export interface ExtractionRequest {
  text: string; // cleaned readable text, already truncated to 200k by the caller
}

function modelId(): string {
  const id = process.env[MODEL_ID_ENV];
  if (!id) {
    throw new Error(`${MODEL_ID_ENV} env var is not set`);
  }
  return id;
}

/**
 * Invoke the configured Bedrock model with a single user prompt using the
 * Amazon Nova request/response schema, returning the model's raw text output.
 * Nova is invoked via an inference profile (e.g. global.amazon.nova-2-lite-v1:0);
 * its body uses `schemaVersion`/`inferenceConfig` and the answer lives at
 * `output.message.content[0].text`. Kept private: the only entry points are
 * extract/explain.
 */
async function invoke(prompt: string, maxTokens: number): Promise<string> {
  const body = JSON.stringify({
    schemaVersion: 'messages-v1',
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens, temperature: 0 },
  });

  const res = await client.send(
    new InvokeModelCommand({
      modelId: modelId(),
      contentType: 'application/json',
      accept: 'application/json',
      body,
    })
  );

  const payload = JSON.parse(textDecoder.decode(res.body)) as {
    output?: { message?: { content?: { text?: string }[] } };
  };

  const text = (payload.output?.message?.content ?? [])
    .map((block) => block.text ?? '')
    .join('')
    .trim();

  if (!text) {
    throw new Error('Bedrock returned an empty response');
  }
  return text;
}

/**
 * Pull a JSON object out of a model response that may be wrapped in prose or a
 * fenced code block, then parse it. Returns `undefined` when nothing parses so
 * the caller can decide to retry.
 */
function parseJsonObject(raw: string): unknown {
  let candidate = raw.trim();

  // Strip a Markdown code fence if the model added one despite instructions.
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    candidate = fence[1].trim();
  }

  // Fall back to the first balanced-looking `{...}` slice.
  if (!candidate.startsWith('{')) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      candidate = candidate.slice(start, end + 1);
    }
  }

  return JSON.parse(candidate);
}

const EXTRACTION_INSTRUCTIONS = [
  'You analyze a document and extract structured knowledge.',
  'Return ONLY minified JSON (no markdown, no code fence, no prose) with EXACTLY these keys:',
  '{"topics":string[],"concepts":string[],"claims":string[],"difficulty":"INTRO"|"INTERMEDIATE"|"ADVANCED"|"EXPERT","summary":string}',
  'Constraints: topics<=50, concepts<=100, claims<=50, summary<=500 characters.',
  'difficulty MUST be one of INTRO, INTERMEDIATE, ADVANCED, EXPERT.',
].join('\n');

/**
 * Extract structured {@link Extraction} data from readable document text.
 *
 * Builds a prompt instructing the model to return ONLY minified JSON matching
 * the extraction shape, invokes Bedrock, then parses and validates with
 * {@link extractionResponseSchema}. On a JSON or Zod failure it retries up to 2
 * times with a stricter reminder, then throws — letting the pipeline mark the
 * document Degraded (Req 4.5).
 */
export async function bedrockExtract(req: ExtractionRequest): Promise<Extraction> {
  const basePrompt = `${EXTRACTION_INSTRUCTIONS}\n\nDOCUMENT:\n${req.text}`;
  const maxAttempts = 2; // 1 initial + 1 retry (token-cost control)
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt =
      attempt === 1
        ? basePrompt
        : `${basePrompt}\n\nREMINDER: Your previous response was invalid. Respond with ONLY the minified JSON object described above and nothing else.`;

    try {
      const raw = await invoke(prompt, 2048);
      const parsed = extractionResponseSchema.parse(parseJsonObject(raw));
      return {
        topics: parsed.topics,
        concepts: parsed.concepts,
        claims: parsed.claims,
        difficulty: parsed.difficulty,
        summary: parsed.summary,
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `bedrockExtract failed after ${maxAttempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

// ---------------------------------------------------------------------------
// LLM semantic scoring (bedrockScore) — the primary scoring path.
//
// Replaces the deterministic string-match relevance/novelty/redundancy with a
// genuine semantic JUDGEMENT made by the model against the user's FULL rich
// profile text. The deterministic functions in `@app/shared` are kept as a
// fallback (see the worker) and still produce freshness + MKV.
// ---------------------------------------------------------------------------

/** Enforced bedrockScore output shape. Scores are integers 0..100. */
export const bedrockScoreResponseSchema = z.object({
  relevance: z.number().min(0).max(100),
  novelty: z.number().min(0).max(100),
  redundancy: z.number().min(0).max(100),
  reasoning: z.string().min(1).max(1500),
});

export type BedrockScoreResponse = z.infer<typeof bedrockScoreResponseSchema>;

export interface ScoreRequest {
  extraction: Extraction;
  profile: Profile;
}

/**
 * Maximum number of characters of the free-text "About you" context sent into a
 * scoring/explain prompt. The schema allows up to 20,000 chars, but sending the
 * whole thing in 2 of the 3 per-document LLM calls inflates tokens and
 * multiplies throttling. We cap the context fed to the model to keep prompts
 * cheap; the user's full text is still stored intact. Tune this if a larger
 * context measurably improves scoring quality.
 */
export const MAX_PROFILE_CONTEXT_CHARS = 2000;

/** Truncate the context to the cap, appending a short notice when cut. */
function capContext(context: string): string {
  if (context.length <= MAX_PROFILE_CONTEXT_CHARS) return context;
  return `${context.slice(0, MAX_PROFILE_CONTEXT_CHARS)}\n[context truncated]`;
}

/**
 * Render the user's profile as a single rich-text block for the scoring prompt.
 * Every stored field is included so the model's judgement sees ALL the context,
 * not a bag of keywords. List fields are joined into readable sentences; the
 * free-text "About you" block (profile.context) carries the primary signal and
 * is capped at {@link MAX_PROFILE_CONTEXT_CHARS} to bound prompt size.
 */
export function buildProfileText(profile: Profile): string {
  const list = (label: string, arr: string[]) => (arr.length ? `${label}: ${arr.join('; ')}.` : '');
  const parts = [
    profile.context ? `About the user:\n${capContext(profile.context)}` : '',
    list('High interests', profile.highInterests),
    list('Medium interests', profile.mediumInterests),
    list('Currently researching', profile.currentlyResearching),
    list('Active contexts / projects', profile.activeContexts),
    list('Already known (do not re-explain fundamentals of these)', profile.alreadyKnown),
    list('Avoid content types', profile.avoidContentTypes),
  ];
  return parts.filter(Boolean).join('\n\n').trim();
}

const SCORING_INSTRUCTIONS = [
  'You are a strict personal relevance engine for ONE specific user.',
  'Judge a document against the user profile and output three scores (0-100) plus reasoning.',
  'This is a SEMANTIC judgement about meaning and value, NOT keyword or string matching.',
  '',
  'relevance = how much this document matters to THIS user given their background, interests, active research and projects.',
  'novelty = how much genuinely NEW capability/insight it brings relative to what the user already knows.',
  'redundancy = how much the document merely repeats things the user already knows or has clearly seen.',
  '',
  'The user strongly prefers signal over volume. It is acceptable and often correct to score a document low and conclude it contains nothing sufficiently new or relevant.',
  "'Already known' means do not re-explain fundamentals; a known topic can still score high only if it brings a genuinely new capability/pattern/limitation/benchmark/architectural implication, otherwise deprioritize introductory coverage.",
  '',
  "reasoning MUST explain WHY the document matters (or does not) FOR THIS USER'S BACKGROUND specifically — not a generic summary. 1 to 3 sentences, concrete.",
  '',
  'Return ONLY minified JSON (no markdown, no code fence, no prose) with EXACTLY these keys:',
  '{"relevance":number,"novelty":number,"redundancy":number,"reasoning":string}',
  'Each score is an integer 0-100. reasoning <= 1500 characters.',
].join('\n');

/**
 * Score a document semantically against the user's full profile. Returns the
 * three LLM scores plus a reasoning string (used as the recommendation
 * explanation). Retries up to 2 times on a JSON/Zod failure, then throws so the
 * worker can fall back to the deterministic scorer (Req: never lose a score).
 */
export async function bedrockScore(req: ScoreRequest): Promise<BedrockScoreResponse> {
  const profileText = buildProfileText(req.profile) || '(The user has not described a profile.)';
  const docBlock = JSON.stringify({
    topics: req.extraction.topics,
    concepts: req.extraction.concepts,
    claims: req.extraction.claims,
    difficulty: req.extraction.difficulty,
    summary: req.extraction.summary,
  });
  const basePrompt = `${SCORING_INSTRUCTIONS}\n\nUSER PROFILE:\n${profileText}\n\nDOCUMENT:\n${docBlock}`;
  const maxAttempts = 2; // 1 initial + 1 retry (token-cost control)
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt =
      attempt === 1
        ? basePrompt
        : `${basePrompt}\n\nREMINDER: Your previous response was invalid. Respond with ONLY the minified JSON object described above and nothing else.`;

    try {
      const raw = await invoke(prompt, 1024);
      const parsed = bedrockScoreResponseSchema.parse(parseJsonObject(raw));
      return {
        relevance: Math.round(parsed.relevance),
        novelty: Math.round(parsed.novelty),
        redundancy: Math.round(parsed.redundancy),
        reasoning: parsed.reasoning.trim(),
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `bedrockScore failed after ${maxAttempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

export interface ExplainInput {
  extraction: Extraction;
  scores: Scores;
  state: RecommendationState;
  profile: Profile;
  tags: RecommendationTag[];
}

/**
 * Produce a written explanation (50..1500 chars) covering (a) why the document
 * matters to this user, (b) what is genuinely new, and (c) why the assigned
 * recommendation state was chosen (Req 6.2). Returns the raw string; the worker
 * (task 6.4) applies the placeholder fallback when this fails or is too short
 * (Req 6.6).
 */
export async function bedrockExplain(input: ExplainInput): Promise<string> {
  const { extraction, scores, state, profile, tags } = input;

  const profileSummary = {
    highInterests: profile.highInterests,
    mediumInterests: profile.mediumInterests,
    currentlyResearching: profile.currentlyResearching,
    activeContexts: profile.activeContexts,
    alreadyKnown: profile.alreadyKnown,
    // Cap the free-text context to bound prompt size (same cap as scoring).
    context: profile.context ? capContext(profile.context) : profile.context,
  };

  const prompt = [
    'You explain a reading recommendation to a user in plain language.',
    'Write a single explanation between 50 and 1500 characters. No markdown, no headings, no JSON.',
    'It MUST cover all three of:',
    '(a) why this document matters to THIS user given their profile,',
    '(b) what is genuinely new to this user,',
    `(c) why the recommendation state "${state}" was chosen.`,
    tags.includes('REDUNDANT')
      ? "This document was judged redundant: state explicitly that no materially new content was detected relative to the user's prior knowledge."
      : '',
    '',
    `RECOMMENDATION_STATE: ${state}`,
    `TAGS: ${tags.join(', ') || 'none'}`,
    `SCORES: ${JSON.stringify(scores)}`,
    `USER_PROFILE: ${JSON.stringify(profileSummary)}`,
    `DOCUMENT_EXTRACTION: ${JSON.stringify({
      topics: extraction.topics,
      concepts: extraction.concepts,
      claims: extraction.claims,
      difficulty: extraction.difficulty,
      summary: extraction.summary,
    })}`,
  ]
    .filter(Boolean)
    .join('\n');

  return invoke(prompt, 1024);
}

// ---------------------------------------------------------------------------
// Profile draft from free text (bedrockDraftProfileFromText) — "Import from URL"
// / "paste text". Turns a block of text ABOUT a person into a DRAFT reading
// profile the user then reviews and edits (never saved blind).
// ---------------------------------------------------------------------------

/** Enforced draft-profile output shape. Lists of short strings + a short context. */
export const draftProfileResponseSchema = z.object({
  highInterests: z.array(z.string()).max(100).default([]),
  mediumInterests: z.array(z.string()).max(100).default([]),
  currentlyResearching: z.array(z.string()).max(100).default([]),
  alreadyKnown: z.array(z.string()).max(100).default([]),
  activeContexts: z.array(z.string()).max(100).default([]),
  avoidContentTypes: z.array(z.string()).max(100).default([]),
  context: z.string().max(600).default(''),
});

export type DraftProfileResponse = z.infer<typeof draftProfileResponseSchema>;

// Bound the text we feed into the single draft-generation call (token control).
const MAX_DRAFT_SOURCE_CHARS = 20_000;

const DRAFT_PROFILE_INSTRUCTIONS = [
  'From the following text about a person, produce a draft reading profile as JSON',
  '{highInterests[],mediumInterests[],currentlyResearching[],alreadyKnown[],activeContexts[],avoidContentTypes[],context(<=600 chars)}.',
  'Only output minified JSON.',
].join(' ');

/**
 * Generate a DRAFT reading profile from arbitrary text about a person. Reuses
 * the same Nova {@link invoke} + {@link parseJsonObject} path as scoring, with a
 * bounded retry on a JSON/validation failure. Returns the parsed draft; the
 * caller fills the edit form with it (the draft is NEVER saved automatically).
 */
export async function bedrockDraftProfileFromText(text: string): Promise<DraftProfileResponse> {
  const source = text.trim().slice(0, MAX_DRAFT_SOURCE_CHARS);
  const basePrompt = `${DRAFT_PROFILE_INSTRUCTIONS}\n\nTEXT:\n${source}`;
  const maxAttempts = 2; // 1 initial + 1 retry
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt =
      attempt === 1
        ? basePrompt
        : `${basePrompt}\n\nREMINDER: Respond with ONLY the minified JSON object described above and nothing else.`;
    try {
      const raw = await invoke(prompt, 1024);
      return draftProfileResponseSchema.parse(parseJsonObject(raw));
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `bedrockDraftProfileFromText failed after ${maxAttempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}
