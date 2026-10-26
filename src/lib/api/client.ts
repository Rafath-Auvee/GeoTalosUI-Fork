import ky, { type Options } from 'ky';

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api/v1';

/**
 * Token getter registered by the React layer (SessionSync or any auth-aware component).
 * Falls back to window.Clerk.session.getToken() as a last resort.
 */
let _tokenGetter: (() => Promise<string | null>) | null = null;

// ── Token deduplication cache ──────────────────────────────────────────────────
// Clerk JWTs live for 60 s. Caching the resolved token for 30 s means:
//   • All concurrent callers (e.g. 20–50 tile requests firing simultaneously)
//     share a single getToken() call instead of hammering Clerk's SDK.
//   • Polling queries (5 s interval) coalesce to ≤ 1 real token fetch per 30 s.
//   • Worst-case the cached token still has 30 s of life remaining — well within
//     the backend's 60 s verification window.
// The cache is busted immediately whenever registerTokenGetter is called (org
// switch, sign-out / re-auth) so stale org-scoped tokens are never reused.
let _tokenCache: { token: string; expiresAt: number } | null = null;
let _tokenInflight: Promise<string | null> | null = null;
const TOKEN_CACHE_MS = 30_000;
/** Never hand out a token with less than this left: it can expire before the request is verified. */
const TOKEN_MIN_LIFE_MS = 10_000;

/** Expiry (ms epoch) from the JWT's own `exp` claim, or null if it can't be read. */
function tokenExpiryMs(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function registerTokenGetter(fn: () => Promise<string | null>) {
  _tokenGetter = fn;
  // Bust cache so the next call gets a fresh org-scoped token.
  _tokenCache = null;
  _tokenInflight = null;
}

export async function getAuthToken(): Promise<string | null> {
  // Serve from cache if still fresh.
  if (_tokenCache && Date.now() < _tokenCache.expiresAt) {
    return _tokenCache.token;
  }

  // Deduplicate concurrent callers: if a fetch is already in flight, reuse it.
  if (_tokenInflight) return _tokenInflight;

  _tokenInflight = (async (): Promise<string | null> => {
    let token: string | null = null;
    try {
      if (_tokenGetter) {
        token = await _tokenGetter();
      } else {
        // Fallback: try window.Clerk directly (before SessionSync has mounted).
        const clerk = (window as unknown as { Clerk?: { session?: { getToken: () => Promise<string | null> } } }).Clerk;
        token = (await clerk?.session?.getToken()) ?? null;
      }
    } catch {
      token = null;
    }

    if (token) {
      // Cache until 30 s from now or shortly before the token's own expiry, whichever is first.
      // (A fixed 30 s could outlive a token Clerk had already half-spent, so requests went out expired.)
      const exp = tokenExpiryMs(token);
      const until = exp ? Math.min(Date.now() + TOKEN_CACHE_MS, exp - TOKEN_MIN_LIFE_MS) : Date.now() + TOKEN_CACHE_MS;
      if (until > Date.now()) _tokenCache = { token, expiresAt: until };
    }
    _tokenInflight = null;
    return token;
  })();

  return _tokenInflight;
}

/**
 * Bust the token cache and fetch a fresh Clerk JWT immediately.
 * Call this before authenticated requests that follow long-running
 * unauthenticated operations (e.g. multipart part uploads) where the
 * cached token may have expired.
 */
export async function refreshAuthToken(): Promise<string | null> {
  _tokenCache = null;
  _tokenInflight = null;
  return getAuthToken();
}

/**
 * Client-side ky instance.
 * Automatically injects the Clerk session JWT as a Bearer token.
 * Register a token getter via registerTokenGetter() for reliable auth.
 */
// Backend list endpoints paginate on `limit`/`offset` (see MAX_PAGE_SIZE=100),
// but much of the frontend passes `page_size`. Since the backend never reads
// `page_size`, those requests silently fell back to the default 20 rows. This
// hook maps `page_size` → `limit` so existing callers get what they asked for.
//   • Only fills `limit` when a caller hasn't set one explicitly — so an
//     intentional `limit` (e.g. features `limit: 10000`) is left untouched.
//   • Clamps to 100, the max these list endpoints accept, to avoid 422s from
//     callers that request more (e.g. `page_size: 1000`).
const PAGE_SIZE_CAP = 100;
function normalizePagination(request: Request): Request | undefined {
  const url = new URL(request.url);
  const sp = url.searchParams;
  if (!sp.has('page_size')) return undefined;

  const pageSize = Number(sp.get('page_size'));
  sp.delete('page_size');
  if (!sp.has('limit') && Number.isFinite(pageSize) && pageSize > 0) {
    sp.set('limit', String(Math.min(pageSize, PAGE_SIZE_CAP)));
  }
  return new Request(url, request);
}

/**
 * fetch that survives an expired session token. A Clerk JWT lives 60 s and can
 * be stale by the time a request is verified ("Signature has expired", 401). The
 * request is cloned before sending; on a 401 we fetch a fresh token and replay the
 * clone once, so a stale token never surfaces as a user-facing error. Cloning first
 * keeps POST bodies replayable.
 */
const fetchWithAuthRetry: typeof fetch = async (input, init) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const replay = req.clone();
  const res = await fetch(req);
  if (res.status !== 401 || replay.headers.get('x-auth-retried')) return res;
  const fresh = await refreshAuthToken();
  if (!fresh) return res;
  replay.headers.set('Authorization', `Bearer ${fresh}`);
  replay.headers.set('x-auth-retried', '1');
  return fetch(replay);
};

export const apiClient = ky.create({
  prefixUrl: API_BASE,
  fetch: fetchWithAuthRetry,
  timeout: 60_000, // 60 s — large dataset lists / tile registrations can be slow
  hooks: {
    beforeRequest: [
      // A single hook: ky stops running beforeRequest hooks as soon as one
      // returns a Request (see its core loop — `break` on `instanceof Request`),
      // so normalizing pagination and attaching the auth header must happen
      // in the same hook. Splitting them silently dropped the Authorization
      // header on every request that carried `page_size` (i.e. every list
      // call), since normalizePagination's returned Request short-circuited
      // the loop before the auth hook ever ran.
      async (request) => {
        const normalized = normalizePagination(request) ?? request;
        const token = await getAuthToken();
        if (token) {
          normalized.headers.set('Authorization', `Bearer ${token}`);
        }
        return normalized;
      },
    ],
  },
});

/**
 * Server-side fetch helper for Route Handlers and Server Components.
 * Caller must supply the token (from `await auth().getToken()`).
 */
export function serverFetch(token: string, options?: Options) {
  return ky.create({
    prefixUrl: API_BASE,
    timeout: 30_000,
    headers: { Authorization: `Bearer ${token}` },
    ...options,
  });
}
