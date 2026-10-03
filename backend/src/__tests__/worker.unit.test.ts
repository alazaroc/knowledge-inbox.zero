/**
 * Task 6.7 — Unit tests for worker degradation, truncation, S3 offload,
 * and the explanation placeholder.
 *
 * Requirements: 4.5 (degraded still produces a recommendation from metadata
 * only), 4.6 (truncation at 200k), 4.7 (S3 offload at 300KB), 6.6 (explanation
 * placeholder with explanationUnavailable while scores + state persist).
 */
import { PutObjectCommand } from '@aws-sdk/client-s3';

import {
  createInMemoryDdb,
  emptyProfile,
  makeBatch,
  makeDocument,
  sqsEvent,
} from './worker-test-harness.js';

const { store, send } = createInMemoryDdb();
jest.mock('../lib/dynamo.js', () => ({ ddb: { send: (...a: unknown[]) => send(...a) } }));

const retrieveReadable = jest.fn();
jest.mock('../lib/retrieve.js', () => ({
  retrieveReadable: (...a: unknown[]) => retrieveReadable(...a),
}));

const bedrockExtract = jest.fn();
const bedrockExplain = jest.fn();
const bedrockScore = jest.fn();
jest.mock('../lib/bedrock.js', () => ({
  bedrockExtract: (...a: unknown[]) => bedrockExtract(...a),
  bedrockExplain: (...a: unknown[]) => bedrockExplain(...a),
  bedrockScore: (...a: unknown[]) => bedrockScore(...a),
}));

const s3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({ send: (...a: unknown[]) => s3Send(...a) })),
  };
});

import { handler } from '../handlers/analysis-worker.js';

// --- Fixtures ------------------------------------------------------------
const OWNER = 'owner-u';
const BATCH = 'batch-u';
const DOC = 'doc-u';
const URL = 'https://example.com/article';

function seedOneDoc() {
  store.batches.clear();
  store.documents.clear();
  store.profiles.clear();
  store.counts.clear();
  store.batches.set(BATCH, makeBatch(BATCH, OWNER, 1));
  store.documents.set(DOC, makeDocument(DOC, OWNER, BATCH, URL));
  store.profiles.set(OWNER, emptyProfile(OWNER));
}

function runOne() {
  return handler(sqsEvent([{ documentId: DOC, batchId: BATCH, ownerId: OWNER }]));
}

function validExtraction() {
  return {
    topics: ['topic'],
    concepts: ['concept'],
    claims: ['claim'],
    difficulty: 'INTRO' as const,
    summary: 'short summary',
  };
}

const LONG_EXPLANATION =
  'This is a sufficiently long explanation that comfortably exceeds the fifty character minimum.';

beforeEach(() => {
  jest.clearAllMocks();
  seedOneDoc();
  process.env.BEDROCK_MODEL_ID = 'test-model';
  process.env.CONTENT_BUCKET = 'test-bucket';
  s3Send.mockResolvedValue({});
  bedrockExtract.mockResolvedValue(validExtraction());
  bedrockExplain.mockResolvedValue(LONG_EXPLANATION);
  // Default: LLM scoring fails, so the worker uses the deterministic fallback
  // scorer and the dedicated bedrockExplain path (these suites assert on both).
  // The happy-path "reasoning becomes explanation" case is tested explicitly.
  bedrockScore.mockRejectedValue(new Error('llm scoring unavailable in this suite'));
});

// --- Degraded path (Req 4.5) ---------------------------------------------
describe('worker — degraded retrieval still produces a recommendation (Req 4.5)', () => {
  it('completes the document from metadata only and skips extraction', async () => {
    retrieveReadable.mockResolvedValue({
      // no text
      degraded: true,
      reason: 'timeout',
      metadata: { sourceDomain: 'example.com' },
    });

    const res = await runOne();

    const doc = store.documents.get(DOC)!;
    expect(doc.status).toBe('completed');
    expect(doc.recommendationState).toBeDefined();
    expect(doc.scores).toBeDefined();
    expect(doc.degraded).toBe(true);
    // extraction never called because there was no readable text.
    expect(bedrockExtract).not.toHaveBeenCalled();
    expect(doc.extraction).toBeUndefined();
    // Successful completion → not reported as a batch item failure.
    expect(res.batchItemFailures).toHaveLength(0);
    // Batch finished with one completed.
    const batch = store.batches.get(BATCH)!;
    expect(batch.completed).toBe(1);
    expect(batch.status).toBe('finished');
  });
});

// --- Truncation (Req 4.6) ------------------------------------------------
describe('worker — truncates text beyond 200k before extraction (Req 4.6)', () => {
  it('passes at most 200000 chars to bedrockExtract and marks extraction.truncated', async () => {
    const hugeText = 'a'.repeat(250_000);
    retrieveReadable.mockResolvedValue({
      text: hugeText,
      html: '<html></html>',
      metadata: { sourceDomain: 'example.com' },
      degraded: false,
    });

    await runOne();

    expect(bedrockExtract).toHaveBeenCalledTimes(1);
    const arg = bedrockExtract.mock.calls[0][0] as { text: string };
    expect(arg.text.length).toBe(200_000);

    const doc = store.documents.get(DOC)!;
    expect(doc.extraction?.truncated).toBe(true);
    expect(doc.status).toBe('completed');
  });

  it('does not mark truncated when text is within the limit', async () => {
    retrieveReadable.mockResolvedValue({
      text: 'a'.repeat(1000),
      html: '<html></html>',
      metadata: { sourceDomain: 'example.com' },
      degraded: false,
    });

    await runOne();

    const arg = bedrockExtract.mock.calls[0][0] as { text: string };
    expect(arg.text.length).toBe(1000);
    expect(store.documents.get(DOC)!.extraction?.truncated).toBe(false);
  });
});

// --- S3 offload (Req 4.7) ------------------------------------------------
describe('worker — offloads large raw content to S3 (Req 4.7)', () => {
  it('puts an object at `${ownerId}/${documentId}.txt` and sets s3ContentRef', async () => {
    const bigHtml = '<html>' + 'x'.repeat(400_000) + '</html>';
    retrieveReadable.mockResolvedValue({
      text: 'readable text that is short',
      html: bigHtml,
      metadata: { sourceDomain: 'example.com' },
      degraded: false,
    });

    await runOne();

    expect(s3Send).toHaveBeenCalledTimes(1);
    const putCmd = s3Send.mock.calls[0][0] as PutObjectCommand;
    expect(putCmd).toBeInstanceOf(PutObjectCommand);
    expect(putCmd.input.Key).toBe(`${OWNER}/${DOC}.txt`);
    expect(putCmd.input.Bucket).toBe('test-bucket');

    const doc = store.documents.get(DOC)!;
    expect(doc.s3ContentRef).toBe(`${OWNER}/${DOC}.txt`);
    expect(doc.status).toBe('completed');
  });

  it('does not offload when content is below the 300KB threshold', async () => {
    retrieveReadable.mockResolvedValue({
      text: 'small text',
      html: '<html>small</html>',
      metadata: { sourceDomain: 'example.com' },
      degraded: false,
    });

    await runOne();

    expect(s3Send).not.toHaveBeenCalled();
    expect(store.documents.get(DOC)!.s3ContentRef).toBeUndefined();
  });
});

// --- Explanation placeholder (Req 6.6) -----------------------------------
describe('worker — explanation placeholder with scores still persisted (Req 6.6)', () => {
  const PLACEHOLDER = 'Explanation unavailable; recommendation and scores were still computed.';

  function okRetrieve() {
    retrieveReadable.mockResolvedValue({
      text: 'readable content',
      html: '<html>readable content</html>',
      metadata: { sourceDomain: 'example.com' },
      degraded: false,
    });
  }

  it('uses the placeholder and flags explanationUnavailable when bedrockExplain throws', async () => {
    okRetrieve();
    bedrockExplain.mockRejectedValue(new Error('bedrock explain failed'));

    await runOne();

    const doc = store.documents.get(DOC)!;
    expect(doc.explanation).toBe(PLACEHOLDER);
    expect(doc.explanationUnavailable).toBe(true);
    // Scores + state still persisted.
    expect(doc.scores).toBeDefined();
    expect(doc.recommendationState).toBeDefined();
    expect(doc.status).toBe('completed');
  });

  it('uses the placeholder when the explanation is shorter than 50 chars', async () => {
    okRetrieve();
    bedrockExplain.mockResolvedValue('too short');

    await runOne();

    const doc = store.documents.get(DOC)!;
    expect(doc.explanation).toBe(PLACEHOLDER);
    expect(doc.explanationUnavailable).toBe(true);
    expect(doc.scores).toBeDefined();
    expect(doc.recommendationState).toBeDefined();
  });

  it('keeps the real explanation when it is long enough', async () => {
    okRetrieve();

    await runOne();

    const doc = store.documents.get(DOC)!;
    expect(doc.explanation).toBe(LONG_EXPLANATION);
    expect(doc.explanationUnavailable).toBe(false);
  });
});

// --- LLM scoring (bedrockScore) is the primary path ----------------------
describe('worker — bedrockScore drives scores and reasoning becomes the explanation', () => {
  const REASONING =
    'This matters to you because it introduces a genuinely new serverless pattern you have not covered yet.';

  it('uses LLM relevance/novelty/redundancy and the reasoning as the explanation (no bedrockExplain)', async () => {
    retrieveReadable.mockResolvedValue({
      text: 'readable content',
      html: '<html>readable content</html>',
      metadata: { sourceDomain: 'example.com' },
      degraded: false,
    });
    bedrockScore.mockResolvedValue({
      relevance: 82,
      novelty: 71,
      redundancy: 12,
      reasoning: REASONING,
    });

    await runOne();

    const doc = store.documents.get(DOC)!;
    expect(doc.scores?.relevance).toBe(82);
    expect(doc.scores?.novelty).toBe(71);
    expect(doc.scores?.redundancy).toBe(12);
    // Explanation comes from the scoring reasoning; not "unavailable".
    expect(doc.explanation).toBe(REASONING);
    expect(doc.explanationUnavailable).toBe(false);
    // The dedicated explanation call is skipped when reasoning is present.
    expect(bedrockExplain).not.toHaveBeenCalled();
    expect(doc.status).toBe('completed');
  });

  // Token-cost control (block 2a): a DISCARDED document (state SKIP) does not
  // spend a bedrockExplain call when there is no reusable scoring reasoning;
  // the placeholder is used instead.
  it('skips bedrockExplain for a discarded (SKIP) document and uses the placeholder', async () => {
    const PLACEHOLDER = 'Explanation unavailable; recommendation and scores were still computed.';
    retrieveReadable.mockResolvedValue({
      text: 'readable content',
      html: '<html>readable content</html>',
      metadata: { sourceDomain: 'example.com' },
      degraded: false,
    });
    // redundancy >= 80 forces SKIP; a short reasoning (< 50 chars) is not usable
    // as the explanation, so without the guard the worker would call explain.
    bedrockScore.mockResolvedValue({
      relevance: 10,
      novelty: 5,
      redundancy: 90,
      reasoning: 'redundant',
    });

    await runOne();

    const doc = store.documents.get(DOC)!;
    expect(doc.recommendationState).toBe('SKIP');
    expect(bedrockExplain).not.toHaveBeenCalled();
    expect(doc.explanation).toBe(PLACEHOLDER);
    expect(doc.explanationUnavailable).toBe(true);
    expect(doc.status).toBe('completed');
  });
});
