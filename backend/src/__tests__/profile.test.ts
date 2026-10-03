import type { APIGatewayProxyEvent } from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { TABLE_NAMES, type Profile } from '@app/shared';

// --- Mocks ---------------------------------------------------------------
// Mock the shared DynamoDB document client: we only care about `send`.
const send = jest.fn();
jest.mock('../lib/dynamo.js', () => ({ ddb: { send: (...args: unknown[]) => send(...args) } }));

// Keep the real `handler-utils` (so `parseBody` schema validation runs for
// real) but stub `verifyToken` from `auth.ts`. Mocking the auth module also
// avoids constructing the Cognito JWT verifier at import time, which requires
// env vars not present under test. `authenticate` wraps `verifyToken`, so
// controlling it fully determines the authenticated subject.
const SUB = 'user-sub-123';
const verifyToken = jest.fn();
jest.mock('../lib/auth.js', () => ({ verifyToken: (...args: unknown[]) => verifyToken(...args) }));

import { handler } from '../handlers/profile.js';

// --- Helpers -------------------------------------------------------------
function event(method: string, body?: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: method,
    body: body === undefined ? null : JSON.stringify(body),
    headers: {},
    pathParameters: null,
  } as unknown as APIGatewayProxyEvent;
}

/** Default: authenticated as `sub`. Override per-test when needed. */
function authAs(sub: string) {
  verifyToken.mockResolvedValue({ sub, email: 'u@test.dev', role: 'USER' });
}

beforeEach(() => {
  jest.clearAllMocks();
  authAs(SUB);
});

// --- Tests ---------------------------------------------------------------

describe('profile handler — GET (empty-profile default, Req 1.4)', () => {
  it('returns an empty, notConfigured profile when the user has none', async () => {
    send.mockResolvedValueOnce({}); // GetCommand → no Item

    const res = await handler(event('GET'));

    expect(res.statusCode).toBe(200);
    const profile = JSON.parse(res.body) as Profile;
    expect(profile.userId).toBe(SUB);
    expect(profile.notConfigured).toBe(true);
    expect(profile.context).toBe('');
    expect(profile.highInterests).toEqual([]);
    expect(profile.mediumInterests).toEqual([]);
    expect(profile.currentlyResearching).toEqual([]);
    expect(profile.alreadyKnown).toEqual([]);
    expect(profile.avoidContentTypes).toEqual([]);
    expect(profile.activeContexts).toEqual([]);
  });

  it('returns the stored profile when one exists', async () => {
    const stored: Profile = {
      userId: SUB,
      highInterests: ['ai'],
      mediumInterests: [],
      currentlyResearching: [],
      alreadyKnown: [],
      avoidContentTypes: [],
      activeContexts: [],
      context: 'hi',
      profileSourceUrl: '',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };
    send.mockResolvedValueOnce({ Item: stored });

    const res = await handler(event('GET'));

    expect(res.statusCode).toBe(200);
    const profile = JSON.parse(res.body) as Profile;
    expect(profile).toEqual(stored);
    expect(profile.notConfigured).toBeUndefined();
  });
});

describe('profile handler — owner isolation (Req 1.6)', () => {
  it('scopes the GET read to the authenticated sub', async () => {
    authAs('other-sub-999');
    send.mockResolvedValueOnce({});

    await handler(event('GET'));

    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(GetCommand);
    expect(cmd.input).toMatchObject({
      TableName: TABLE_NAMES.PROFILES,
      Key: { userId: 'other-sub-999' },
    });
  });

  it('scopes the PUT read and write to the authenticated sub', async () => {
    authAs('other-sub-999');
    send
      .mockResolvedValueOnce({}) // GetCommand (createdAt lookup) → none
      .mockResolvedValueOnce({}); // PutCommand

    await handler(event('PUT', { highInterests: ['x'] }));

    const getCmd = send.mock.calls[0][0];
    const putCmd = send.mock.calls[1][0];
    expect(getCmd).toBeInstanceOf(GetCommand);
    expect(getCmd.input.Key).toEqual({ userId: 'other-sub-999' });
    expect(putCmd).toBeInstanceOf(PutCommand);
    expect(putCmd.input.TableName).toBe(TABLE_NAMES.PROFILES);
    expect((putCmd.input.Item as Profile).userId).toBe('other-sub-999');
  });
});

describe('profile handler — PUT replace semantics (Req 1.3)', () => {
  it('replaces all fields and stamps a server-generated updatedAt', async () => {
    const before = Date.now();
    send
      .mockResolvedValueOnce({}) // createdAt lookup → none
      .mockResolvedValueOnce({}); // PutCommand

    const res = await handler(
      event('PUT', {
        highInterests: ['serverless', 'ai'],
        mediumInterests: ['design'],
        currentlyResearching: ['bedrock'],
        activeContexts: ['kiz'],
        alreadyKnown: ['dynamodb'],
        avoidContentTypes: ['video'],
        context: 'builder',
      })
    );

    expect(res.statusCode).toBe(200);
    const saved = JSON.parse(res.body) as Profile;

    // Returned body matches what was persisted via PutCommand.
    const putCmd = send.mock.calls[1][0] as PutCommand;
    expect(putCmd).toBeInstanceOf(PutCommand);
    expect(putCmd.input.Item as Profile).toEqual(saved);

    expect(saved.userId).toBe(SUB);
    expect(saved.highInterests).toEqual(['serverless', 'ai']);
    expect(saved.mediumInterests).toEqual(['design']);
    expect(saved.currentlyResearching).toEqual(['bedrock']);
    expect(saved.activeContexts).toEqual(['kiz']);
    expect(saved.alreadyKnown).toEqual(['dynamodb']);
    expect(saved.avoidContentTypes).toEqual(['video']);
    expect(saved.context).toBe('builder');
    expect(saved.notConfigured).toBeUndefined();

    // Server stamps updatedAt (ISO, generated now — not trusted from client).
    const stamped = Date.parse(saved.updatedAt);
    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before);
  });

  it('preserves the original createdAt when a profile already exists', async () => {
    send
      .mockResolvedValueOnce({ Item: { createdAt: '2020-05-05T05:05:05.000Z' } })
      .mockResolvedValueOnce({});

    const res = await handler(event('PUT', { highInterests: ['x'] }));
    const saved = JSON.parse(res.body) as Profile;

    expect(saved.createdAt).toBe('2020-05-05T05:05:05.000Z');
    expect(saved.updatedAt).not.toBe('2020-05-05T05:05:05.000Z');
  });
});

describe('profile handler — PUT validation rejection (Req 1.5, 1.8)', () => {
  it('rejects a context longer than 2000 chars and persists nothing', async () => {
    const res = await handler(event('PUT', { context: 'a'.repeat(2001) }));

    expect(res.statusCode).toBe(400);
    // No DynamoDB interaction at all when the body fails validation.
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a list with more than 50 entries and persists nothing', async () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `entry-${i}`);
    const res = await handler(event('PUT', { highInterests: tooMany }));

    expect(res.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects an entry longer than 200 chars and persists nothing', async () => {
    const res = await handler(event('PUT', { alreadyKnown: ['a'.repeat(201)] }));

    expect(res.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});
