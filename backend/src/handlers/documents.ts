import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  RECOMMENDATION_STATE,
  TABLE_NAMES,
  documentPatchSchema,
  type Batch,
  type KnowledgeDocument,
  type LibraryResponse,
  type RecommendationState,
} from '@app/shared';
import { ddb } from '../lib/dynamo.js';
import { authenticate } from '../lib/handler-utils.js';
import { badRequest, created, noContent, notFound, ok, serverError } from '../lib/response.js';
import { newId, now } from '../lib/ids.js';

const sqs = new SQSClient({});
const queueUrl = () => process.env.ANALYSIS_QUEUE_URL ?? '';

/**
 * Read-only library + document detail for the Knowledge Inbox Zero domain.
 *
 * Deterministic only — this handler NEVER calls Bedrock. All reads are scoped
 * to the authenticated owner (`ctx.sub`, Req 7.6).
 *
 * - GET /documents              → library: a page of ≤100 owned documents plus
 *                                 owner-wide per-state counts + total that
 *                                 reflect the ENTIRE owned set regardless of
 *                                 pagination (Req 7.2–7.5, 7.7).
 * - GET /documents/{documentId} → detail: metadata/summary/scores/state/
 *                                 explanation; 404 when missing or not owned
 *                                 (Req 7.8, 7.9, 6.7, 6.8).
 * - POST /documents/{documentId}/reanalyze → re-queue an owned document for a
 *                                 fresh analysis against the CURRENT profile
 *                                 (useful after editing the profile, or to
 *                                 retry a document that degraded). Creates a
 *                                 single-document batch and re-enqueues it.
 */

// Only ≤100 documents are returned per page (Req 7.7).
const PAGE_LIMIT = 100;

// Sentinel prefix for the per-owner counts aggregate item that shares the
// documents table (`documentId = "COUNTS#<ownerId>"`). It carries `ownerId`,
// so it surfaces in the `byOwner` GSI and must be excluded from the document
// list; it has no `stateKey`, so it never surfaces in `byOwnerState`.
const COUNTS_PREFIX = 'COUNTS#';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const method = event.httpMethod;
    const documentId = event.pathParameters?.documentId;
    const isReanalyze =
      event.resource?.endsWith('/reanalyze') || event.path?.endsWith('/reanalyze');

    if (method === 'POST' && documentId && isReanalyze) return reanalyzeDocument(event);
    if (method === 'GET' && !documentId) return listDocuments(event);
    if (method === 'GET' && documentId) return getDocument(event);
    if (method === 'PATCH' && documentId) return patchDocument(event);
    if (method === 'DELETE' && documentId) return deleteDocument(event);

    return badRequest('Unrecognized route');
  } catch (err) {
    return serverError(err);
  }
};

/** True for the per-owner counts aggregate sentinel item (not a real document). */
function isCountsItem(item: { documentId?: string }): boolean {
  return (
    typeof item.documentId === 'string' &&
    (item.documentId.startsWith(COUNTS_PREFIX) || item.documentId.startsWith('USAGE#'))
  );
}

/** Narrow an arbitrary string to a defined recommendation state (Req 7.5). */
function parseState(value: string | undefined): RecommendationState | undefined | 'invalid' {
  if (value === undefined) return undefined;
  return (RECOMMENDATION_STATE as readonly string[]).includes(value)
    ? (value as RecommendationState)
    : 'invalid';
}

/** Base64url-encode a DynamoDB LastEvaluatedKey into an opaque cursor. */
function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), 'utf-8').toString('base64url');
}

/** Decode an opaque cursor back into an ExclusiveStartKey, or 'invalid'. */
function decodeCursor(cursor: string): Record<string, unknown> | 'invalid' {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return 'invalid';
  } catch {
    return 'invalid';
  }
}

/**
 * Read the per-owner counts aggregate (`COUNTS#<ownerId>`) and project it onto
 * the LibraryResponse counts shape. Every defined state defaults to 0 when the
 * aggregate item, or an individual state counter, is absent (Req 7.3). The
 * counts reflect the whole owned set and are pagination-independent (Req 7.2,
 * 7.7).
 */
async function readCounts(ownerId: string): Promise<LibraryResponse['counts']> {
  const r = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAMES.DOCUMENTS,
      Key: { documentId: `${COUNTS_PREFIX}${ownerId}` },
    })
  );
  const agg = (r.Item ?? {}) as Partial<Record<RecommendationState | 'total', number>>;

  const counts = { total: 0 } as LibraryResponse['counts'];
  for (const state of RECOMMENDATION_STATE) {
    counts[state] = typeof agg[state] === 'number' ? agg[state] : 0;
  }
  counts.total = typeof agg.total === 'number' ? agg.total : 0;
  return counts;
}

async function listDocuments(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const auth = await authenticate(event);
  if ('error' in auth) return auth.error;
  const ownerId = auth.ctx.sub;

  // Validate the optional ?state= filter against the taxonomy (Req 7.5).
  const q = event.queryStringParameters ?? {};
  const state = parseState(q.state ?? undefined);
  if (state === 'invalid') return badRequest('Invalid recommendation state');

  // Decode the optional continuation cursor (Req 7.7).
  let exclusiveStartKey: Record<string, unknown> | undefined;
  if (q.cursor) {
    const decoded = decodeCursor(q.cursor);
    if (decoded === 'invalid') return badRequest('Invalid cursor');
    exclusiveStartKey = decoded;
  }

  // Counts always reflect the ENTIRE owned set, independent of the page or the
  // state filter (Req 7.2, 7.3, 7.7).
  const counts = await readCounts(ownerId);

  // A state filter uses the byOwnerState GSI (SK `<state>#<documentId>`); the
  // unfiltered library uses the byOwner GSI. Both are keyed on ownerId (Req 7.6).
  const query = state
    ? new QueryCommand({
        TableName: TABLE_NAMES.DOCUMENTS,
        IndexName: 'byOwnerState',
        KeyConditionExpression: 'ownerId = :o AND begins_with(stateKey, :s)',
        ExpressionAttributeValues: { ':o': ownerId, ':s': `${state}#` },
        Limit: PAGE_LIMIT,
        ExclusiveStartKey: exclusiveStartKey,
      })
    : new QueryCommand({
        TableName: TABLE_NAMES.DOCUMENTS,
        IndexName: 'byOwner',
        KeyConditionExpression: 'ownerId = :o',
        ExpressionAttributeValues: { ':o': ownerId },
        Limit: PAGE_LIMIT,
        ExclusiveStartKey: exclusiveStartKey,
      });

  const r = await ddb.send(query);

  // Exclude the COUNTS aggregate sentinel; it shares the table and appears in
  // the byOwner GSI (Req 7.2 — it is not a document).
  const documents = ((r.Items ?? []) as KnowledgeDocument[]).filter((d) => !isCountsItem(d));

  const response: LibraryResponse = { documents, counts };
  if (r.LastEvaluatedKey) {
    response.nextCursor = encodeCursor(r.LastEvaluatedKey as Record<string, unknown>);
  }
  return ok(response);
}

async function getDocument(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const auth = await authenticate(event);
  if ('error' in auth) return auth.error;

  const documentId = event.pathParameters?.documentId;
  if (!documentId) return badRequest('Missing documentId');

  const r = await ddb.send(
    new GetCommand({ TableName: TABLE_NAMES.DOCUMENTS, Key: { documentId } })
  );
  const doc = r.Item as KnowledgeDocument | undefined;

  // 404 when missing OR owned by another user — never leak existence (Req 7.9).
  if (!doc || doc.ownerId !== auth.ctx.sub) return notFound('Document');

  // Return the full document: metadata, summary (in extraction), scores, state,
  // explanation (Req 7.8, 6.7, 6.8).
  return ok(doc);
}

/**
 * PATCH /documents/{documentId} — user lifecycle + feedback.
 *
 * Accepts `{ archived?: boolean, userFeedback?: 'up' | 'down' | null }`. Scoped
 * to the owner (404 when missing or owned by another user — never leak
 * existence). Does NOT touch the per-owner COUNTS aggregate: archiving hides a
 * document from the default view but it still exists and still counts toward
 * "attention saved"; feedback is a pure signal. Returns the updated document.
 */
async function patchDocument(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const auth = await authenticate(event);
  if ('error' in auth) return auth.error;
  const ownerId = auth.ctx.sub;

  const documentId = event.pathParameters?.documentId;
  if (!documentId) return badRequest('Missing documentId');

  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }
  const parsed = documentPatchSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? 'Invalid request body');
  }

  const r = await ddb.send(
    new GetCommand({ TableName: TABLE_NAMES.DOCUMENTS, Key: { documentId } })
  );
  const doc = r.Item as KnowledgeDocument | undefined;
  if (!doc || doc.ownerId !== ownerId) return notFound('Document');

  // Build a dynamic UpdateExpression from the fields actually provided.
  const sets: string[] = ['updatedAt = :ts'];
  const removes: string[] = [];
  const values: Record<string, unknown> = { ':ts': now() };

  if (parsed.data.archived !== undefined) {
    sets.push('archived = :archived');
    values[':archived'] = parsed.data.archived;
  }
  if (parsed.data.userFeedback !== undefined) {
    if (parsed.data.userFeedback === null) {
      removes.push('userFeedback');
    } else {
      sets.push('userFeedback = :feedback');
      values[':feedback'] = parsed.data.userFeedback;
    }
  }

  let updateExpression = `SET ${sets.join(', ')}`;
  if (removes.length > 0) updateExpression += ` REMOVE ${removes.join(', ')}`;

  const updated = await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.DOCUMENTS,
      Key: { documentId },
      UpdateExpression: updateExpression,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    })
  );

  return ok(updated.Attributes as KnowledgeDocument);
}

/**
 * DELETE /documents/{documentId} — hard delete.
 *
 * Permanently removes the item and decrements the per-owner COUNTS aggregate:
 * -1 on its current recommendationState (if any) and -1 on total. Scoped to the
 * owner (404 when missing or owned by another user). Returns 204.
 */
async function deleteDocument(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const auth = await authenticate(event);
  if ('error' in auth) return auth.error;
  const ownerId = auth.ctx.sub;

  const documentId = event.pathParameters?.documentId;
  if (!documentId) return badRequest('Missing documentId');

  const r = await ddb.send(
    new GetCommand({ TableName: TABLE_NAMES.DOCUMENTS, Key: { documentId } })
  );
  const doc = r.Item as KnowledgeDocument | undefined;
  if (!doc || doc.ownerId !== ownerId) return notFound('Document');

  // Hard delete the item itself.
  await ddb.send(new DeleteCommand({ TableName: TABLE_NAMES.DOCUMENTS, Key: { documentId } }));

  // Decrement the per-owner COUNTS aggregate: always -1 total, plus -1 on the
  // document's recommendation state when it had one. READ/SKIM/SKIP are passed
  // via ExpressionAttributeNames (READ is a DynamoDB reserved word).
  const priorState = doc.recommendationState;
  const hasState =
    priorState !== undefined && (RECOMMENDATION_STATE as readonly string[]).includes(priorState);

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.DOCUMENTS,
      Key: { documentId: `${COUNTS_PREFIX}${ownerId}` },
      UpdateExpression: hasState
        ? 'ADD #state :neg1, #total :neg1 SET updatedAt = :ts'
        : 'ADD #total :neg1 SET updatedAt = :ts',
      ExpressionAttributeNames: hasState
        ? { '#state': priorState as string, '#total': 'total' }
        : { '#total': 'total' },
      ExpressionAttributeValues: { ':neg1': -1, ':ts': now() },
    })
  );

  return noContent();
}

/**
 * Re-queue an owned document for a fresh analysis.
 *
 * Why this exists: scores are computed against the owner's profile at analysis
 * time, so after editing the profile the prior scores are stale. This is also
 * the retry path for a document that previously degraded (e.g. a transient
 * fetch/model failure now fixed).
 *
 * Counter correctness: the worker's `bumpStateCount` adds to the per-owner
 * COUNTS aggregate on EVERY terminal transition and is not idempotent, so a
 * naive re-queue double-counts. We therefore decrement the document's current
 * recommendation state from COUNTS here (if it had one), making the worker's
 * eventual re-increment a net no-op. We also reset the document to `pending`
 * and clear its stale `stateKey` so it no longer shows under the old state's
 * filtered view until the fresh analysis lands.
 */
async function reanalyzeDocument(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const auth = await authenticate(event);
  if ('error' in auth) return auth.error;
  const ownerId = auth.ctx.sub;

  const documentId = event.pathParameters?.documentId;
  if (!documentId) return badRequest('Missing documentId');

  const r = await ddb.send(
    new GetCommand({ TableName: TABLE_NAMES.DOCUMENTS, Key: { documentId } })
  );
  const doc = r.Item as KnowledgeDocument | undefined;
  // 404 when missing OR owned by another user — never leak existence (Req 7.9).
  if (!doc || doc.ownerId !== ownerId) return notFound('Document');

  // Don't double-queue a document still in flight.
  if (doc.status === 'pending' || doc.status === 'processing') {
    return badRequest('Document is already being analyzed');
  }

  const priorState = doc.recommendationState;

  // COUNTS correctness across re-analysis. The worker's `bumpStateCount` adds
  // BOTH `total` and the doc's state on completion and is not idempotent, so a
  // re-queue would double-count. We pre-decrement here what the worker will
  // re-add, netting to zero:
  //   - `total`: the doc already counted toward total on its FIRST completion
  //     (every completed/degraded doc passes through bumpStateCount), so a doc
  //     in a terminal status must have its total decremented now — otherwise
  //     each re-analysis inflates the library total by 1 (observed bug).
  //   - its prior state counter: decremented when it had a valid one.
  const wasTerminal = doc.status === 'completed' || doc.status === 'failed';
  const hadState =
    Boolean(priorState) && (RECOMMENDATION_STATE as readonly string[]).includes(priorState!);
  if (wasTerminal || hadState) {
    const names: Record<string, string> = {};
    const adds: string[] = [];
    if (wasTerminal) {
      names['#total'] = 'total';
      adds.push('#total :neg1');
    }
    if (hadState) {
      names['#state'] = priorState as string;
      adds.push('#state :neg1');
    }
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAMES.DOCUMENTS,
        Key: { documentId: `COUNTS#${ownerId}` },
        UpdateExpression: `ADD ${adds.join(', ')} SET updatedAt = :ts`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: { ':neg1': -1, ':ts': now() },
      })
    );
  }

  // Create a single-document batch so the frontend can poll progress exactly
  // like a normal import.
  const ts = now();
  const batchId = newId();
  const batch: Batch = {
    batchId,
    ownerId,
    status: 'processing',
    total: 1,
    pending: 1,
    processing: 0,
    completed: 0,
    failed: 0,
    rejected: [],
    createdAt: ts,
    updatedAt: ts,
  };
  await ddb.send(new PutCommand({ TableName: TABLE_NAMES.BATCHES, Item: batch }));

  // Reset the document to pending for the new run; drop the stale stateKey so
  // it leaves the old state's filtered view immediately.
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAMES.DOCUMENTS,
      Key: { documentId },
      UpdateExpression:
        'SET #status = :pending, batchId = :batchId, updatedAt = :ts REMOVE stateKey',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pending': 'pending', ':batchId': batchId, ':ts': ts },
    })
  );

  // Enqueue the single analysis message for the async worker.
  const url = queueUrl();
  if (url) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: url,
        MessageBody: JSON.stringify({ documentId, batchId, ownerId }),
      })
    );
  }

  return created({ batchId, total: 1, pending: 1, rejected: [] });
}
