import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

/**
 * One Secrets Manager secret holds EVERY user's private-repo token as a JSON
 * map `{ "<userSub>": "<token>" }`. One secret (not one-per-user) keeps cost
 * flat at this scale. Tokens are fine-grained, read-only, single-repo PATs.
 *
 * The secret value is NEVER returned to the client — the profile handler only
 * exposes a `hasToken` boolean, and the worker reads the token server-side to
 * fetch a private profile source.
 */
const sm = new SecretsManagerClient({});
const secretId = () => process.env.PROFILE_TOKENS_SECRET ?? '';

type TokenMap = Record<string, string>;

async function readMap(): Promise<TokenMap> {
  const id = secretId();
  if (!id) return {};
  try {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: id }));
    const raw = r.SecretString?.trim();
    if (!raw) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // The secret exists but its value is not JSON yet (e.g. a freshly created
      // secret still holding a default-generated string). Treat as empty — the
      // next write replaces it with a proper JSON map.
      return {};
    }
    return parsed && typeof parsed === 'object' ? (parsed as TokenMap) : {};
  } catch (err) {
    // ResourceNotFoundException (secret exists but has no version yet) → empty.
    if (err instanceof Error && err.name === 'ResourceNotFoundException') return {};
    throw err;
  }
}

async function writeMap(map: TokenMap): Promise<void> {
  const id = secretId();
  if (!id) return;
  await sm.send(new PutSecretValueCommand({ SecretId: id, SecretString: JSON.stringify(map) }));
}

/** Whether a token is stored for this user (no value exposed). */
export async function hasUserToken(userSub: string): Promise<boolean> {
  const map = await readMap();
  return Boolean(map[userSub]);
}

/** Store (non-empty) or clear (empty/undefined) this user's token. */
export async function setUserToken(userSub: string, token: string | undefined): Promise<void> {
  const map = await readMap();
  const trimmed = (token ?? '').trim();
  if (trimmed) {
    map[userSub] = trimmed;
  } else if (userSub in map) {
    delete map[userSub];
  } else {
    return; // nothing to change
  }
  await writeMap(map);
}

/** Read this user's token for server-side use (worker only). */
export async function getUserToken(userSub: string): Promise<string | undefined> {
  const map = await readMap();
  const t = map[userSub];
  return t && t.trim() ? t.trim() : undefined;
}
