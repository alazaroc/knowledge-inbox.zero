/**
 * Shared test harness for the analysis worker (tasks 6.6, 6.7, 6.8).
 *
 * All three worker test files mock the same modules in the same way, so the
 * mocking approach lives here. Each test file still declares its own
 * `jest.mock(...)` factories (jest requires the call site to be in the test
 * file for hoisting), but delegates to the spies and the in-memory DynamoDB
 * built here so behaviour is identical across files.
 *
 * The in-memory DynamoDB applies the exact `UpdateCommand` expressions the
 * worker uses (the atomic `ADD` counter moves and the conditional
 * `maybeFinishBatch`), so we can drive real documents through `processDocument`
 * and assert the batch-counter invariant after each SQS invocation.
 */
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { TABLE_NAMES, type Batch, type KnowledgeDocument, type Profile } from '@app/shared';

// ---------------------------------------------------------------------------
// In-memory DynamoDB
// ---------------------------------------------------------------------------

export interface InMemoryStore {
  batches: Map<string, Batch>;
  documents: Map<string, KnowledgeDocument>;
  profiles: Map<string, Profile>;
  /** `COUNTS#<ownerId>` aggregate items from bumpStateCount. */
  counts: Map<string, Record<string, number>>;
}

export interface ConditionalCheckFailed extends Error {
  name: 'ConditionalCheckFailedException';
}

function conditionalCheckFailed(): ConditionalCheckFailed {
  const err = new Error('The conditional request failed') as ConditionalCheckFailed;
  err.name = 'ConditionalCheckFailedException';
  return err;
}

/**
 * Create a fresh in-memory store plus a `send` implementation that interprets
 * the subset of DynamoDB operations the worker performs. Returns both so tests
 * can seed documents/profiles and later inspect the mutated batch.
 */
export function createInMemoryDdb() {
  const store: InMemoryStore = {
    batches: new Map(),
    documents: new Map(),
    profiles: new Map(),
    counts: new Map(),
  };

  const send = jest.fn(async (...args: unknown[]): Promise<unknown> => {
    const cmd = args[0];
    if (cmd instanceof GetCommand) return handleGet(store, cmd);
    if (cmd instanceof QueryCommand) return handleQuery(store, cmd);
    if (cmd instanceof UpdateCommand) return handleUpdate(store, cmd);
    throw new Error(`Unexpected DynamoDB command in test: ${String(cmd)}`);
  });

  return { store, send };
}

function handleGet(store: InMemoryStore, cmd: GetCommand): { Item?: unknown } {
  const { TableName, Key } = cmd.input;
  if (TableName === TABLE_NAMES.DOCUMENTS) {
    const id = (Key as { documentId: string }).documentId;
    if (id.startsWith('COUNTS#')) {
      const item = store.counts.get(id);
      return { Item: item };
    }
    return { Item: store.documents.get(id) };
  }
  if (TableName === TABLE_NAMES.PROFILES) {
    const userId = (Key as { userId: string }).userId;
    return { Item: store.profiles.get(userId) };
  }
  if (TableName === TABLE_NAMES.BATCHES) {
    const id = (Key as { batchId: string }).batchId;
    return { Item: store.batches.get(id) };
  }
  throw new Error(`Unexpected GetCommand table: ${String(TableName)}`);
}

function handleQuery(store: InMemoryStore, cmd: QueryCommand): { Items: unknown[] } {
  const { TableName, ExpressionAttributeValues } = cmd.input;
  // The worker only queries the documents table (byOwner GSI) for prior
  // concepts / exact-duplicate detection.
  if (TableName === TABLE_NAMES.DOCUMENTS) {
    const ownerId = (ExpressionAttributeValues as Record<string, string>)?.[':o'];
    const items = [...store.documents.values()].filter((d) => d.ownerId === ownerId);
    return { Items: items };
  }
  throw new Error(`Unexpected QueryCommand table: ${String(TableName)}`);
}

function handleUpdate(store: InMemoryStore, cmd: UpdateCommand): Record<string, never> {
  const { TableName } = cmd.input;
  if (TableName === TABLE_NAMES.BATCHES) {
    applyBatchUpdate(store, cmd);
    return {};
  }
  if (TableName === TABLE_NAMES.DOCUMENTS) {
    applyDocumentUpdate(store, cmd);
    return {};
  }
  throw new Error(`Unexpected UpdateCommand table: ${String(TableName)}`);
}

/**
 * Apply the two kinds of batch UpdateCommand the worker issues:
 *  1. counter move:  `ADD <to> :one, <from> :neg1 SET updatedAt = :ts`
 *  2. finish:        `SET #status = :finished, ... ` with a conditional expr.
 */
function applyBatchUpdate(store: InMemoryStore, cmd: UpdateCommand): void {
  const { Key, UpdateExpression, ConditionExpression, ExpressionAttributeValues } = cmd.input;
  const batchId = (Key as { batchId: string }).batchId;
  const batch = store.batches.get(batchId);
  if (!batch) throw new Error(`Batch ${batchId} not found in in-memory store`);

  const expr = UpdateExpression ?? '';
  const values = (ExpressionAttributeValues ?? {}) as Record<string, unknown>;

  // Finish transition (has a ConditionExpression).
  if (ConditionExpression) {
    const stillWork = batch.pending !== 0 || batch.processing !== 0;
    const alreadyFinished = batch.status === 'finished';
    if (stillWork || alreadyFinished) throw conditionalCheckFailed();
    batch.status = 'finished';
    batch.updatedAt = String(values[':ts'] ?? batch.updatedAt);
    return;
  }

  // Counter move: parse `ADD <to> :one, <from> :neg1 ...`.
  const addPart = /ADD\s+(.+?)(?:\s+SET\b|$)/i.exec(expr)?.[1] ?? '';
  const pairs = addPart
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const pair of pairs) {
    const [counter, valueKey] = pair.split(/\s+/);
    const delta = values[valueKey] as number;
    const name = counter as keyof Batch;
    (batch[name] as number) = ((batch[name] as number) ?? 0) + delta;
  }
  batch.updatedAt = String(values[':ts'] ?? batch.updatedAt);
}

/**
 * Apply the document UpdateCommands: `persistCompleted`, `markFailed`, and the
 * `COUNTS#<ownerId>` aggregate bump. We only need to persist enough state for
 * assertions, so we merge the resolved values onto the stored item.
 */
function applyDocumentUpdate(store: InMemoryStore, cmd: UpdateCommand): void {
  const { Key, UpdateExpression, ExpressionAttributeValues } = cmd.input;
  const documentId = (Key as { documentId: string }).documentId;
  const values = (ExpressionAttributeValues ?? {}) as Record<string, unknown>;
  const expr = UpdateExpression ?? '';

  // COUNTS aggregate bump: `ADD #total :one, #state :one SET ownerId = :o ...`.
  if (documentId.startsWith('COUNTS#')) {
    const names = (cmd.input.ExpressionAttributeNames ?? {}) as Record<string, string>;
    const current = store.counts.get(documentId) ?? {};
    const addPart = /ADD\s+(.+?)(?:\s+SET\b|$)/i.exec(expr)?.[1] ?? '';
    for (const pair of addPart
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const [nameRef, valueKey] = pair.split(/\s+/);
      const resolvedName = names[nameRef] ?? nameRef;
      current[resolvedName] = (current[resolvedName] ?? 0) + (values[valueKey] as number);
    }
    store.counts.set(documentId, current);
    return;
  }

  const doc = store.documents.get(documentId);
  if (!doc) throw new Error(`Document ${documentId} not found in in-memory store`);

  // persistCompleted
  if (values[':status'] === 'completed') {
    doc.status = 'completed';
    doc.metadata = values[':metadata'] as KnowledgeDocument['metadata'];
    doc.extraction = values[':extraction'] as KnowledgeDocument['extraction'];
    doc.scores = values[':scores'] as KnowledgeDocument['scores'];
    doc.recommendationState = values[':state'] as KnowledgeDocument['recommendationState'];
    doc.tags = values[':tags'] as KnowledgeDocument['tags'];
    doc.explanation = values[':explanation'] as string | undefined;
    doc.explanationUnavailable = values[':explanationUnavailable'] as boolean | undefined;
    doc.degraded = values[':degraded'] as boolean | undefined;
    doc.failureReason = values[':failureReason'] as string | undefined;
    doc.s3ContentRef = values[':s3ContentRef'] as string | undefined;
    return;
  }

  // markFailed
  if (values[':status'] === 'failed') {
    doc.status = 'failed';
    doc.failureReason = values[':reason'] as string | undefined;
    return;
  }

  throw new Error(`Unhandled document update for ${documentId}: ${expr}`);
}

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

export function makeBatch(batchId: string, ownerId: string, total: number): Batch {
  return {
    batchId,
    ownerId,
    status: 'processing',
    total,
    pending: total,
    processing: 0,
    completed: 0,
    failed: 0,
    rejected: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

export function makeDocument(
  documentId: string,
  ownerId: string,
  batchId: string,
  canonicalUrl: string
): KnowledgeDocument {
  return {
    documentId,
    ownerId,
    batchId,
    rawUrl: canonicalUrl,
    canonicalUrl,
    status: 'pending',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

export function emptyProfile(userId: string): Profile {
  return {
    userId,
    highInterests: [],
    mediumInterests: [],
    currentlyResearching: [],
    alreadyKnown: [],
    avoidContentTypes: [],
    activeContexts: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

/** Build an SQSEvent with one record per analysis message. */
export function sqsEvent(
  messages: { documentId: string; batchId: string; ownerId: string }[]
): SQSEvent {
  const Records = messages.map(
    (m, i): SQSRecord =>
      ({
        messageId: `msg-${i}-${m.documentId}`,
        body: JSON.stringify(m),
      }) as unknown as SQSRecord
  );
  return { Records } as SQSEvent;
}

/** Assert the core batch-counter invariant (CP-10). */
export function assertCounterInvariant(batch: Batch): void {
  expect(batch.pending + batch.processing + batch.completed + batch.failed).toBe(batch.total);
}
