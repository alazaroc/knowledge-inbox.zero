import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { TABLE_NAMES, profileImportSchema, profileSchema, type Profile } from '@app/shared';
import { ddb } from '../lib/dynamo.js';
import { bedrockDraftProfileFromText } from '../lib/bedrock.js';
import { hasUserToken, setUserToken } from '../lib/profile-tokens.js';
import { authenticate, parseBody } from '../lib/handler-utils.js';
import { badRequest, ok, serverError } from '../lib/response.js';
import { now } from '../lib/ids.js';

/**
 * Per-user knowledge `Profile` — the single source of "what this user already
 * knows and cares about". One item per user, keyed by the Cognito `sub`.
 * - GET /profile → the caller's profile, or the synthetic empty profile
 *   (`notConfigured: true`, all lists empty, no context) when none exists (Req 1.4).
 * - PUT /profile → validate, trim/drop empties (via the schema), replace all
 *   fields, and stamp a server-generated `updatedAt` in UTC (Req 1.3, 1.9).
 * Every read and write is scoped to the authenticated user (Req 1.6).
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const method = event.httpMethod;
    const path = event.resource || event.path || '';
    const isImport = path.endsWith('/profile/import');

    if (method === 'POST' && isImport) return importProfile(event);
    if (method === 'GET') return getProfile(event);
    if (method === 'PUT') return putProfile(event);

    return badRequest('Unrecognized route');
  } catch (err) {
    return serverError(err);
  }
};

// Bounded fetch of a public URL for profile import. Only the fetched TEXT is
// used (to generate a draft); nothing is persisted. Never throws upward with a
// raw network error — returns a user-facing message instead.
const IMPORT_FETCH_TIMEOUT_MS = 10_000;
const IMPORT_FETCH_MAX_CHARS = 50_000;

async function fetchPublicText(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMPORT_FETCH_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) {
      throw new Error(`The URL could not be fetched (HTTP ${res.status}).`);
    }
    const raw = (await res.text()).trim();
    if (!raw) throw new Error('The URL returned no text.');
    return raw.slice(0, IMPORT_FETCH_MAX_CHARS);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('The URL took too long to respond.');
    }
    throw err instanceof Error ? err : new Error('The URL could not be fetched.');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /profile/import — turn a public URL or pasted text into a DRAFT profile
 * via one LLM call. The response is a draft the frontend uses to prefill the
 * edit form; it is NOT saved. The user reviews, edits, and saves via PUT.
 */
async function importProfile(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const auth = await authenticate(event);
  if ('error' in auth) return auth.error;

  const body = parseBody(event, profileImportSchema);
  if ('error' in body) return body.error;

  let sourceText = body.data.text?.trim() ?? '';
  if (!sourceText && body.data.url) {
    try {
      sourceText = await fetchPublicText(body.data.url);
    } catch (err) {
      // A fetch failure (e.g. LinkedIn blocking scraping) is a user-facing 400,
      // not a server error — tell them to paste the text instead.
      return badRequest(
        `${(err as Error).message} Some sites (e.g. LinkedIn) block automated access — paste the text directly instead.`
      );
    }
  }

  if (!sourceText) return badRequest('Provide a URL or paste some text.');

  const draft = await bedrockDraftProfileFromText(sourceText);
  return ok({ draft });
}

/** Builds the synthetic empty profile returned when the user has none (Req 1.4). */
function emptyProfile(userId: string): Profile {
  const ts = now();
  return {
    userId,
    highInterests: [],
    mediumInterests: [],
    currentlyResearching: [],
    alreadyKnown: [],
    avoidContentTypes: [],
    activeContexts: [],
    context: '',
    profileSourceUrl: '',
    notConfigured: true,
    createdAt: ts,
    updatedAt: ts,
  };
}

async function getProfile(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const auth = await authenticate(event);
  if ('error' in auth) return auth.error;

  const r = await ddb.send(
    new GetCommand({ TableName: TABLE_NAMES.PROFILES, Key: { userId: auth.ctx.sub } })
  );
  if (!r.Item) return ok(emptyProfile(auth.ctx.sub));
  const profile = r.Item as Profile;
  // Expose only whether a private-repo token is stored — never the value.
  profile.hasToken = await hasUserToken(auth.ctx.sub);
  return ok(profile);
}

async function putProfile(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const auth = await authenticate(event);
  if ('error' in auth) return auth.error;

  // The schema trims list entries, drops empties (Req 1.7), and enforces the
  // 100-entry / 200-char / 5000-char bounds (Req 1.1, 1.5, 1.8).
  const body = parseBody(event, profileSchema);
  if ('error' in body) return body.error;

  // Preserve the original creation timestamp when one already exists; the
  // server always stamps `updatedAt` and never trusts client time (Req 1.3, 1.9).
  const existing = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAMES.PROFILES,
      Key: { userId: auth.ctx.sub },
      ProjectionExpression: 'createdAt',
    })
  );
  const ts = now();
  const createdAt = (existing.Item?.createdAt as string | undefined) ?? ts;

  // Replace-all semantics: every stored field is overwritten with the
  // submitted values; `notConfigured` is intentionally not set on a real save.
  const profile: Profile = {
    userId: auth.ctx.sub,
    highInterests: body.data.highInterests,
    mediumInterests: body.data.mediumInterests,
    currentlyResearching: body.data.currentlyResearching,
    alreadyKnown: body.data.alreadyKnown,
    avoidContentTypes: body.data.avoidContentTypes,
    activeContexts: body.data.activeContexts,
    context: body.data.context ?? '',
    profileSourceUrl: body.data.profileSourceUrl ?? '',
    profileRepoUrl: body.data.profileRepoUrl ?? '',
    createdAt,
    updatedAt: ts,
  };

  await ddb.send(new PutCommand({ TableName: TABLE_NAMES.PROFILES, Item: profile }));

  // The token is NEVER stored on the profile item — only in Secrets Manager.
  // A provided githubToken sets it; an explicit empty string clears it;
  // `undefined` (field absent) leaves any existing token untouched.
  if (body.data.githubToken !== undefined) {
    await setUserToken(auth.ctx.sub, body.data.githubToken);
  }
  profile.hasToken = await hasUserToken(auth.ctx.sub);

  return ok(profile);
}
