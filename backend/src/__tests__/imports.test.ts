import type { APIGatewayProxyEvent } from 'aws-lambda';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import fc from 'fast-check';
import {
  TABLE_NAMES,
  canonicalizeUrl,
  type Batch,
  type KnowledgeDocument,
  type RejectedEntry,
} from '@app/shared';

// --- Mocks ---------------------------------------------------------------
// Mock the shared DynamoDB document client: we only care about `send`.
const send = jest.fn();
jest.mock('../lib/dynamo.js', () => ({ ddb: { send: (...args: unknown[]) => send(...args) } }));

// Stub `verifyToken` from `auth.ts` (as in profile.test.ts). Mocking the auth
// module also avoids constructing the Cognito JWT verifier at import time.
const SUB = 'user-sub-123';
const verifyToken = jest.fn();
jest.mock('../lib/auth.js', () => ({ verifyToken: (...args: unknown[]) => verifyToken(...args) }));

// Mock the SQS client so no real AWS calls happen. The handler constructs a
// `new SQSClient({})` and calls `sqs.send(new SendMessageBatchCommand(...))`;
// we replace `send` with a resolving spy and keep the real command classes.
const sqsSend = jest.fn();
jest.mock('@aws-sdk/client-sqs', () => {
  const actual = jest.requireActual('@aws-sdk/client-sqs');
  return {
    ...actual,
    SQSClient: jest.fn().mockImplementation(() => ({
      send: (...args: unknown[]) => sqsSend(...args),
    })),
  };
});

import { handler } from '../handlers/imports.js';

// --- Helpers -------------------------------------------------------------
function event(method: string, body?: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: method,
    body: body === undefined ? null : JSON.stringify(body),
    headers: {},
    pathParameters: null,
  } as unknown as APIGatewayProxyEvent;
}

function postImports(urls: string): APIGatewayProxyEvent {
  return event('POST', { urls });
}

/** Default: authenticated as `sub`. */
function authAs(sub: string) {
  verifyToken.mockResolvedValue({ sub, email: 'u@test.dev', role: 'USER' });
}

/** Authenticated as an ADMIN (no daily import quota). */
function authAsAdmin(sub: string) {
  verifyToken.mockResolvedValue({ sub, email: 'admin@test.dev', role: 'ADMIN' });
}

/**
 * Default DynamoDB behaviour: every GetCommand (existing-doc check) returns an
 * empty object (no existing document), and every PutCommand resolves. This lets
 * tests capture the Batch + Document items without wiring per-call mocks.
 */
function ddbNoExistingDocs() {
  send.mockImplementation((cmd: unknown) => {
    if (cmd instanceof GetCommand) return Promise.resolve({});
    return Promise.resolve({});
  });
}

/** All PutCommand items sent to a given table, in order. */
function putItemsForTable<T>(table: string): T[] {
  return send.mock.calls
    .map((c) => c[0] as unknown)
    .filter((cmd): cmd is PutCommand => cmd instanceof PutCommand)
    .filter((cmd) => cmd.input.TableName === table)
    .map((cmd) => cmd.input.Item as T);
}

/** The single Batch item written to the batches table (if any). */
function capturedBatch(): Batch | undefined {
  return putItemsForTable<Batch>(TABLE_NAMES.BATCHES)[0];
}

function anyBatchPut(): boolean {
  return putItemsForTable<Batch>(TABLE_NAMES.BATCHES).length > 0;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default to ADMIN (no daily quota) so the batch-cap, dedup and partition
  // tests are isolated from the per-user daily limit, which has its own block.
  authAsAdmin(SUB);
  ddbNoExistingDocs();
  process.env.ANALYSIS_QUEUE_URL = 'https://sqs.test/queue';
  sqsSend.mockResolvedValue({});
});

// --- Property 15: Import line partition ----------------------------------
// Validates: Requirements 2.1, 2.4
//
// For an arbitrary blob of mixed valid URLs, invalid tokens, and blank/
// whitespace lines, after POST /imports:
//   - every accepted line (observed via the created Batch's new Documents and
//     the within-submission duplicates) is a valid URL post-normalization,
//   - every rejected entry is recorded with a reason,
//   - no line is both accepted and rejected,
//   - blank/whitespace-only lines are discarded entirely (neither accepted nor
//     rejected).
describe('imports handler — Property 15: import line partition (Req 2.1, 2.4)', () => {
  // A clearly-valid URL (fast-check guarantees canonicalizeUrl accepts it).
  const validUrl = fc.webUrl();
  // Clearly-invalid tokens: canonicalizeUrl must throw for these.
  const invalidToken = fc.constantFrom(
    'not a url',
    'http://',
    'https://',
    '   spaced token   ',
    'foo bar baz',
    'http://exa mple.com',
    '::::',
    'ht!tp://@@',
    '>>> nope <<<'
  );
  // Blank / whitespace-only lines: discarded by normalization.
  const blankLine = fc.constantFrom('', '   ', '\t', '  \t  ', '     ');

  const mixedLine = fc.oneof(validUrl, invalidToken, blankLine);

  it('partitions lines into accepted-valid / rejected-recorded / discarded-blank', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Keep well under the 500 post-normalization cap.
        fc.array(mixedLine, { minLength: 1, maxLength: 60 }),
        fc.context(),
        async (lines, ctx) => {
          send.mockClear();
          sqsSend.mockClear();
          ddbNoExistingDocs();

          // Non-blank lines after trimming — the universe the handler partitions.
          const normalized = lines.map((l) => l.trim()).filter((l) => l.length > 0);

          const res = await handler(postImports(lines.join('\n')));

          // All-blank submission → 400, no Batch (covered more fully below).
          if (normalized.length === 0) {
            expect(res.statusCode).toBe(400);
            expect(anyBatchPut()).toBe(false);
            return;
          }

          expect(res.statusCode).toBe(201);
          const batch = capturedBatch();
          expect(batch).toBeDefined();
          if (!batch) return;

          const docs = putItemsForTable<KnowledgeDocument>(TABLE_NAMES.DOCUMENTS);
          const rejected: RejectedEntry[] = batch.rejected;

          // The response body also exposes rejected[].
          const bodyRejected = (JSON.parse(res.body) as { rejected: RejectedEntry[] }).rejected;
          expect(bodyRejected).toEqual(rejected);

          // (a) Every rejected entry is recorded with a non-empty reason, and
          //     its line fails canonicalization (truly invalid).
          for (const r of rejected) {
            expect(typeof r.reason).toBe('string');
            expect(r.reason.length).toBeGreaterThan(0);
            expect(() => canonicalizeUrl(r.line)).toThrow();
          }

          // (b) Every accepted *new* document carries a rawUrl that canonicalizes
          //     to its stored canonicalUrl (accepted ⇒ valid post-normalization).
          for (const d of docs) {
            expect(canonicalizeUrl(d.rawUrl)).toBe(d.canonicalUrl);
          }

          // Reconstruct the accepted set: every normalized line that is NOT a
          // rejected line is an accepted line (duplicates included).
          const rejectedLines = new Set(rejected.map((r) => r.line));
          const acceptedLines = normalized.filter((l) => !rejectedLines.has(l));

          // (c) No line is both accepted and rejected.
          for (const l of acceptedLines) {
            expect(rejectedLines.has(l)).toBe(false);
          }

          // (d) Every accepted line is a valid URL post-normalization.
          for (const l of acceptedLines) {
            expect(() => canonicalizeUrl(l)).not.toThrow();
          }

          // (e) Partition completeness: accepted + rejected == all normalized
          //     (non-blank) lines; blanks are already excluded by `normalized`.
          expect(acceptedLines.length + rejected.length).toBe(normalized.length);

          // (f) Blank/whitespace lines are discarded entirely: none appear in
          //     rejected, and none produced a document.
          const originalBlanks = lines.filter((l) => l.trim().length === 0);
          for (const b of originalBlanks) {
            expect(rejectedLines.has(b)).toBe(false);
            expect(docs.some((d) => d.rawUrl === b)).toBe(false);
          }

          // (g) Counter semantics: total = pending(new docs) + rejected.length;
          //     pending equals the number of distinct new documents.
          expect(batch.pending).toBe(docs.length);
          expect(batch.total).toBe(batch.pending + rejected.length);

          ctx.log(
            `normalized=${normalized.length} accepted=${acceptedLines.length} ` +
              `newDocs=${docs.length} rejected=${rejected.length}`
          );
        }
      ),
      { numRuns: 100 }
    );
  });
});

// --- Example / unit tests ------------------------------------------------
describe('imports handler — empty submission (Req 2.3)', () => {
  it('rejects a blob of only blank/whitespace lines with 400 and no Batch', async () => {
    const res = await handler(postImports('   \n\t\n  \n'));

    expect(res.statusCode).toBe(400);
    expect(anyBatchPut()).toBe(false);
  });

  it('rejects an empty blob after trim (schema still passes a space) with 400', async () => {
    // A single space satisfies the `min(1)` schema but normalizes to zero lines.
    const res = await handler(postImports(' '));

    expect(res.statusCode).toBe(400);
    expect(anyBatchPut()).toBe(false);
  });
});

describe('imports handler — per-batch 500 cap (Req 2.7)', () => {
  const url = (i: number) => `https://example.com/path-${i}`;

  it('accepts exactly 500 normalized lines', async () => {
    const blob = Array.from({ length: 500 }, (_, i) => url(i)).join('\n');

    const res = await handler(postImports(blob));

    expect(res.statusCode).toBe(201);
    const batch = capturedBatch();
    expect(batch).toBeDefined();
    expect(batch?.pending).toBe(500);
    expect(batch?.total).toBe(500);
    expect(putItemsForTable<KnowledgeDocument>(TABLE_NAMES.DOCUMENTS)).toHaveLength(500);
  });

  it('rejects 501 normalized lines with 400 and creates no Batch', async () => {
    const blob = Array.from({ length: 501 }, (_, i) => url(i)).join('\n');

    const res = await handler(postImports(blob));

    expect(res.statusCode).toBe(400);
    expect(anyBatchPut()).toBe(false);
    // No existing-doc lookups either: the cap short-circuits before the loop.
    expect(putItemsForTable<KnowledgeDocument>(TABLE_NAMES.DOCUMENTS)).toHaveLength(0);
  });

  it('ignores blank lines when counting toward the 500 cap', async () => {
    // 500 real URLs interleaved with blanks → still accepted (blanks dropped).
    const parts: string[] = [];
    for (let i = 0; i < 500; i++) {
      parts.push(url(i));
      parts.push(''); // blank between each
    }
    const res = await handler(postImports(parts.join('\n')));

    expect(res.statusCode).toBe(201);
    expect(capturedBatch()?.pending).toBe(500);
  });
});

describe('imports handler — within-submission dedup (Req 2.6)', () => {
  it('creates a single Document for duplicate canonical URLs, counting dupes as accepted', async () => {
    // Three raw forms that canonicalize to the same URL + one distinct URL.
    const dupA = 'https://example.com/a';
    const dupViaTracking = 'https://example.com/a?utm_source=news'; // tracking stripped → same canonical
    const dupNoScheme = 'example.com/a'; // scheme prepended → same canonical
    const distinct = 'https://example.com/b';

    // Sanity: the three "dup" forms really share a canonical URL.
    expect(canonicalizeUrl(dupViaTracking)).toBe(canonicalizeUrl(dupA));
    expect(canonicalizeUrl(dupNoScheme)).toBe(canonicalizeUrl(dupA));

    const blob = [dupA, dupViaTracking, dupNoScheme, distinct].join('\n');
    const res = await handler(postImports(blob));

    expect(res.statusCode).toBe(201);
    const batch = capturedBatch();
    expect(batch).toBeDefined();

    const docs = putItemsForTable<KnowledgeDocument>(TABLE_NAMES.DOCUMENTS);
    // Only two distinct documents created (one per distinct canonical URL).
    expect(docs).toHaveLength(2);

    // No rejections — all four lines are accepted.
    expect(batch?.rejected).toHaveLength(0);
    // pending counts NEW documents only (dedup collapses the three dupes to one).
    expect(batch?.pending).toBe(2);
    expect(batch?.total).toBe(2);

    // One SQS message batch enqueued (2 docs ≤ batch size of 10).
    expect(sqsSend).toHaveBeenCalledTimes(1);
  });
});

// --- Daily import quota (cost control, USER role) ------------------------
// Validates the hard block: a USER may enqueue at most DAILY_IMPORT_LIMIT_USER
// new documents per UTC day. Excess URLs are NOT dropped silently — they are
// returned in `blocked` so the user can save and retry tomorrow. ADMIN is
// unlimited. Quota counts NEW documents only (duplicates/rejected don't count).
describe('imports handler — daily quota hard block (USER)', () => {
  const url = (i: number) => `https://example.com/q-${i}`;

  // Configure DynamoDB mock: no existing docs, and today's USAGE counter reads
  // back `usedToday` (the USAGE#<owner>#<day> item carries `{ count }`).
  function ddbWithUsage(usedToday: number) {
    send.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetCommand) {
        const key = (cmd as GetCommand).input.Key as { documentId?: string } | undefined;
        if (typeof key?.documentId === 'string' && key.documentId.startsWith('USAGE#')) {
          return Promise.resolve({ Item: { count: usedToday } });
        }
        return Promise.resolve({}); // no existing document
      }
      return Promise.resolve({});
    });
  }

  /** The ADD applied to the USAGE counter, if any (its :n value). */
  function usageIncrement(): number | undefined {
    const upd = send.mock.calls
      .map((c) => c[0] as unknown)
      .filter((cmd): cmd is UpdateCommand => cmd instanceof UpdateCommand)
      .find((cmd) => {
        const key = cmd.input.Key as { documentId?: string } | undefined;
        return typeof key?.documentId === 'string' && key.documentId.startsWith('USAGE#');
      });
    return upd?.input.ExpressionAttributeValues?.[':n'] as number | undefined;
  }

  it('enqueues all URLs and consumes quota when under the limit', async () => {
    authAs(SUB);
    ddbWithUsage(0);

    const blob = Array.from({ length: 10 }, (_, i) => url(i)).join('\n');
    const res = await handler(postImports(blob));

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as {
      pending: number;
      blocked: string[];
      dailyLimit: number;
      remaining: number;
    };
    expect(body.pending).toBe(10);
    expect(body.blocked).toHaveLength(0);
    expect(body.dailyLimit).toBe(50);
    expect(body.remaining).toBe(40);
    expect(usageIncrement()).toBe(10);
  });

  it('hard-blocks the excess and returns the unprocessed URLs', async () => {
    authAs(SUB);
    ddbWithUsage(45); // only 5 of today's 50 left

    const blob = Array.from({ length: 12 }, (_, i) => url(i)).join('\n');
    const res = await handler(postImports(blob));

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { pending: number; blocked: string[]; remaining: number };

    // Only 5 enqueued; the remaining 7 are returned as blocked (not dropped).
    expect(body.pending).toBe(5);
    expect(body.blocked).toHaveLength(7);
    expect(body.remaining).toBe(0);

    // The 5 enqueued are the FIRST five; the 7 blocked are the rest, in order.
    const docs = putItemsForTable<KnowledgeDocument>(TABLE_NAMES.DOCUMENTS);
    expect(docs).toHaveLength(5);
    expect(body.blocked).toEqual(Array.from({ length: 7 }, (_, i) => url(i + 5)));

    // Quota consumed only for the 5 enqueued.
    expect(usageIncrement()).toBe(5);
  });

  it('blocks everything when the day is already exhausted, creating no documents', async () => {
    authAs(SUB);
    ddbWithUsage(50); // nothing left today

    const blob = Array.from({ length: 3 }, (_, i) => url(i)).join('\n');
    const res = await handler(postImports(blob));

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { pending: number; blocked: string[] };
    expect(body.pending).toBe(0);
    expect(body.blocked).toHaveLength(3);
    expect(putItemsForTable<KnowledgeDocument>(TABLE_NAMES.DOCUMENTS)).toHaveLength(0);
    // No quota consumed when nothing was enqueued.
    expect(usageIncrement()).toBeUndefined();
    // No SQS messages sent.
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it('ADMIN has no quota: all URLs enqueued, no blocked, no usage write', async () => {
    authAsAdmin(SUB);
    ddbWithUsage(999); // irrelevant for admin

    const blob = Array.from({ length: 80 }, (_, i) => url(i)).join('\n');
    const res = await handler(postImports(blob));

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as {
      pending: number;
      blocked: string[];
      dailyLimit: number | null;
      remaining: number | null;
    };
    expect(body.pending).toBe(80);
    expect(body.blocked).toHaveLength(0);
    expect(body.dailyLimit).toBeNull();
    expect(body.remaining).toBeNull();
    // No USAGE increment for admin.
    expect(usageIncrement()).toBeUndefined();
  });
});
