import { fetchAuthSession } from 'aws-amplify/auth';

const BASE_URL = (import.meta.env.VITE_API_URL as string).replace(/\/$/, '');

async function getAuthHeader(): Promise<Record<string, string>> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

const MAX_RETRIES = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let lastError: Error = new Error('Request failed');

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Exponential backoff with jitter between retries (250ms, 500ms, 1s, 2s…).
    if (attempt > 0) await sleep(2 ** (attempt - 1) * 250 + Math.random() * 200);

    // The token is recomputed on each attempt: a transient session hiccup
    // self-heals on retry (avoids a 401 from the authorizer → "Failed to fetch").
    const authHeaders = await getAuthHeader();

    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      lastError = new Error('Could not reach the server. Check your connection and try again.');
      continue;
    }

    // 429 (throttling) and 5xx are transient → retry with backoff.
    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(`The server is overloaded (${res.status}).`);
      continue;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: 'Request failed' }));
      throw new Error(err.message ?? `Error ${res.status}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json();
  }

  throw lastError;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
