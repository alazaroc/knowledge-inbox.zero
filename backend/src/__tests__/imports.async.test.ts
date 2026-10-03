import fs from 'node:fs';
import path from 'node:path';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { TABLE_NAMES, type Batch, type KnowledgeDocument } from '@app/shared';

// --- Mocks ---------------------------------------------------------------
// Mirror the mocking pattern from `imports.test.ts`: the shared DynamoDB
// document client, the auth module (so no Cognito verifier is constructed at
// import time), and the SQS client (so no real AWS calls happen).

// DynamoDB document client — we only care about `send`.
const send = jest.fn();
jest.mock('../lib/dynamo.js', () => ({ ddb: { send: (...args: unknown[]) => send(...args) } }));

// Auth — stub `verifyToken`.
const SUB = 'user-sub-async';
const verifyToken = jest.fn();
jest.mock('../lib/auth.js', () => ({ verifyToken: (...args: unknown[]) => verifyToken(...args) }));

// SQS — replace `send` with a resolving spy, keep the real command classes so
// `SendMessageBatchCommand` instances can be inspected.
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

// A `fetch` spy so we can assert the handler performs NO network retrieval
// synchronously (document analysis — fetch/readability/Bedrock — belongs to
// the async worker, never to this handler).
const fetchSpy = jest.fn();

import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
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

function authAs(sub: string) {
  verifyToken.mockResolvedValue({ sub, email: 'u@test.dev', role: 'USER' });
}

/** No existing documents: every GetCommand returns empty, every Put resolves. */
function ddbNoExistingDocs() {
  send.mockImplementation((cmd: unknown) => {
    if (cmd instanceof GetCommand) return Promise.resolve({});
    return Promise.resolve({});
  });
}

/** All items written to a given table via PutCommand, in order. */
function putItemsForTable<T>(table: string): T[] {
  return send.mock.calls
    .map((c) => c[0] as unknown)
    .filter((cmd): cmd is PutCommand => cmd instanceof PutCommand)
    .filter((cmd) => cmd.input.TableName === table)
    .map((cmd) => cmd.input.Item as T);
}

function capturedBatch(): Batch | undefined {
  return putItemsForTable<Batch>(TABLE_NAMES.BATCHES)[0];
}

/** The AWS SDK command classes the handler asked the mocked clients to run. */
function ddbCommandNames(): string[] {
  return send.mock.calls.map((c) => (c[0] as object).constructor.name);
}

beforeEach(() => {
  jest.clearAllMocks();
  authAs(SUB);
  ddbNoExistingDocs();
  process.env.ANALYSIS_QUEUE_URL = 'https://sqs.test/queue';
  sqsSend.mockResolvedValue({});
  // Spy on global fetch without allowing a real network call.
  fetchSpy.mockReset();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

// --- Integration: async boundary -----------------------------------------
// Validates: Requirements 3.1, NFR-2
//
// POST /imports must acknowledge the Batch quickly WITHOUT performing any
// document analysis synchronously. Analysis (fetch → readability → Bedrock
// extraction → scoring → explanation) is the async worker's job. We assert
// this structurally: the handler returns 201 with every created document in
// `pending`, the batch in `processing`, it only touches DynamoDB + SQS, and it
// never invokes fetch or any Bedrock client (the handler imports neither).
describe('imports handler — async boundary (Req 3.1, NFR-2)', () => {
  const urls = [
    'https://example.com/alpha',
    'https://example.com/beta',
    'https://example.com/gamma',
  ];

  it('returns 201 with documents pending and batch processing, without analyzing synchronously', async () => {
    const res = await handler(postImports(urls.join('\n')));

    // (1) Fast acknowledgement with 201 (Req 3.1).
    expect(res.statusCode).toBe(201);

    // (2) The created batch is in `processing`, not a terminal state — no
    //     analysis has run, so nothing can be `finished` yet.
    const batch = capturedBatch();
    expect(batch).toBeDefined();
    expect(batch?.status).toBe('processing');

    // (3) Every created document is `pending`. None was advanced to
    //     `processing`/`completed`/`failed` by this handler (NFR-2).
    const docs = putItemsForTable<KnowledgeDocument>(TABLE_NAMES.DOCUMENTS);
    expect(docs).toHaveLength(urls.length);
    for (const d of docs) {
      expect(d.status).toBe('pending');
    }
    expect(docs.every((d) => d.status === 'pending')).toBe(true);

    // (4) Batch counters reflect "nothing analyzed yet": all pending.
    expect(batch?.pending).toBe(urls.length);
    expect(batch?.processing).toBe(0);
    expect(batch?.completed).toBe(0);
    expect(batch?.failed).toBe(0);

    // (5) The response acknowledges the batch (id + counts) — no analysis
    //     results (scores/summary/explanation) are returned inline.
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.batchId).toBe(batch?.batchId);
    expect(body.pending).toBe(urls.length);
    expect(body).not.toHaveProperty('scores');
    expect(body).not.toHaveProperty('documents');
  });

  it('performs no synchronous analysis I/O: only DynamoDB + one SQS enqueue, no fetch/Bedrock', async () => {
    const res = await handler(postImports(urls.join('\n')));
    expect(res.statusCode).toBe(201);

    // (1) The handler enqueues exactly one SendMessageBatch (3 docs <= 10) and
    //     hands analysis off to the async worker.
    expect(sqsSend).toHaveBeenCalledTimes(1);
    const sqsArg = sqsSend.mock.calls[0][0];
    expect(sqsArg).toBeInstanceOf(SendMessageBatchCommand);

    // (2) The only AWS commands issued are DynamoDB Get/Put/Update (the Update
    //     is the daily-quota counter). Query is not used on the create path,
    //     and no analysis-time command appears.
    const names = ddbCommandNames();
    expect(names.length).toBeGreaterThan(0);
    const allowed = new Set(['GetCommand', 'PutCommand', 'UpdateCommand']);
    for (const n of names) {
      expect(allowed.has(n)).toBe(true);
    }
    expect(names).not.toContain(QueryCommand.name);

    // (3) No synchronous content retrieval happened: fetch was never called.
    //     (Retrieval + Bedrock extraction live in the async worker.)
    expect(fetchSpy).not.toHaveBeenCalled();

    // (4) Structural guarantee that this handler cannot call Bedrock: its
    //     source imports no Bedrock SDK. If that ever changes, this test flags
    //     the regression (the async boundary would be violated).
    const handlerSource = readImportsSource();
    expect(handlerSource).not.toMatch(/@aws-sdk\/client-bedrock/);
    expect(handlerSource).not.toMatch(/InvokeModel/);
  });

  it('acknowledges well under the 3s budget (non-flaky, generous threshold)', async () => {
    // SQS/DynamoDB are mocked to resolve immediately, so this measures only the
    // handler's own synchronous work. A generous ceiling keeps it non-flaky
    // while still asserting the handler does not block on analysis.
    const startedAt = Date.now();
    const res = await handler(postImports(urls.join('\n')));
    const elapsedMs = Date.now() - startedAt;

    expect(res.statusCode).toBe(201);
    expect(elapsedMs).toBeLessThan(3000);
  });
});

// --- Source-level guard helper -------------------------------------------
// Reads the handler source once to assert, structurally, that the create path
// has no Bedrock dependency. Kept at the bottom to avoid cluttering the specs.
// Resolution is anchored on this test file's own directory (`__dirname`, which
// ts-jest provides under its CommonJS transform) so it is independent of the
// process working directory.
function readImportsSource(): string {
  const candidate = path.join(__dirname, '..', 'handlers', 'imports.ts');
  return fs.readFileSync(candidate, 'utf8');
}
