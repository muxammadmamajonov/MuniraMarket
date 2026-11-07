import {
  API_V1_PREFIX,
  LOCALE_COOKIE,
  negotiateLocale,
  type TelegramOidcFailureStatus,
} from '@muniramarket/contracts';
import { getApiInternalUrl, getClientIpHeader } from '@/lib/config';
import { clientIpFrom } from './client-ip';
import { newRequestId, parseRequestId, REQUEST_ID_HEADER, supportCodeFor } from './request-id';
import { upstreamFetch } from './upstream-fetch';

/** Largest request body the proxy forwards. The API's own limit is at least as strict. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * The one route with a larger limit: the catalog CSV import (a raw `text/csv` body, 1 MiB at the
 * API as well). Only this exact path (POST) gets it; everything else stays at
 * {@link MAX_BODY_BYTES}.
 */
export const MAX_CSV_IMPORT_BYTES = 1024 * 1024;
const CSV_IMPORT_PATH = 'admin/catalog/csv/import';

function bodyLimitFor(method: string, segments: readonly string[]): number {
  return method === 'POST' && segments.join('/') === CSV_IMPORT_PATH
    ? MAX_CSV_IMPORT_BYTES
    : MAX_BODY_BYTES;
}

/**
 * How long we wait for the Core API, retry included, before answering 504. It must be longer than
 * the gateway's own 20 s (`services/api-gateway/src/forward.ts`): the gateway then answers first
 * with its precise error, and a slow cold start (Neon Function scale-from-zero plus a suspended
 * Postgres compute) that the gateway would still have waited for is not cut short here. It used
 * to be 15 s, shorter than the gateway budget it wraps, so a cold start between 15 and 20 s failed
 * here as `service_unavailable` although the request was about to succeed.
 */
export const UPSTREAM_TIMEOUT_MS = 25_000;

/** Pause before the single retry (see {@link isRetryable}). */
export const RETRY_DELAY_MS = 250;

/** A retry is only started when at least this much of {@link UPSTREAM_TIMEOUT_MS} is left. */
export const MIN_RETRY_BUDGET_MS = 5_000;

/**
 * Answers worth one more try: the gateway could not reach the Function (502), or the Function
 * could not reach Postgres in time (503, e.g. the pool's 10 s connect timeout while a suspended
 * compute wakes up). Never 504: the budget is spent.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([502, 503]);

/**
 * Which entrance this app is, sent to the Core API as `x-mm-entrance` on every upstream request.
 * In production the Cloudflare gateway sets the same header; locally (and in E2E) there is no
 * gateway, so the proxy sets it. A browser-sent `x-mm-entrance` is never forwarded: it is not in
 * {@link FORWARDED_REQUEST_HEADERS} and is always overwritten here.
 */
export const ENTRANCE = 'admin';

/**
 * The only upstream redirect passed through to the browser: the end of the Telegram OIDC sign-in.
 * The Core API answers it with `303` and a relative `Location` (the `return_to` page, or the
 * sign-in failure page), plus the session cookie on success.
 */
const OIDC_CALLBACK_PATH = 'auth/telegram/oidc/callback';
const OIDC_START_PATH = 'auth/telegram/oidc/start';

/**
 * `true` for a same-origin, path-absolute `Location` such as `/uz/orders?x=1`: it starts with a
 * single `/` (not `//`, which is protocol-relative), has no backslash (browsers treat `/\` like
 * `//`), no control characters or spaces, and still resolves to the same origin.
 */
export function isSafeRelativeLocation(location: string): boolean {
  if (location.length === 0 || location.length > 2048) return false;
  if (!location.startsWith('/') || location.startsWith('//')) return false;
  // Control characters (including tab/CR/LF, which URL parsing strips), DEL, space, backslash.
  if (/[\u0000- \u007f\\]/.test(location)) return false;
  try {
    const base = 'http://same-origin.invalid';
    return new URL(location, base).origin === base;
  } catch {
    return false;
  }
}

/** Request headers forwarded to the Core API. Everything else (Host, Connection, ...) is dropped. */
const FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'accept-language',
  'cookie',
  'x-csrf-token',
  'origin',
  'user-agent',
] as const;

/** Response headers returned to the browser. `set-cookie` is handled separately (multi-value). */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'retry-after', 'cache-control'] as const;

export interface ProxyDeps {
  fetch: typeof fetch;
  /** Core API base URL, no trailing slash. */
  apiBaseUrl: () => string;
  /** Edge-set header holding the real client IP, or `null` (see `getClientIpHeader`). */
  clientIpHeader?: () => string | null;
  /** Test seams: clock, the pause before a retry, and the request id generator. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  requestId?: () => string;
}

export interface ProxyRouteContext {
  params: Promise<{ path: string[] }>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId?: string,
): Response {
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  if (requestId !== undefined) headers[REQUEST_ID_HEADER] = requestId;
  return Response.json({ error: { code, message } }, { status, headers });
}

/**
 * One JSON line for the operator's log (Workers Logs / server stdout): the request id, the route
 * (never the query: the OIDC callback's query holds the authorization code), statuses and
 * timings. Never cookies, headers, bodies or IPs.
 */
function logUpstreamFailure(fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: 'error', msg: 'admin api proxy', ...fields }));
}

/**
 * Segments that could escape `/api/v1/` or address a different route once forwarded. Route params
 * arrive already percent-decoded, so an encoded `..` or `/` shows up literally here.
 */
function hasUnsafeSegment(segments: readonly string[]): boolean {
  return segments.some(
    (segment) =>
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('/') ||
      segment.includes('\\') ||
      segment.includes('\0'),
  );
}

/**
 * The only Core API routes the admin exposes to a browser: the Telegram OIDC sign-in (start and
 * callback) and the session routes it needs, and the back office (`admin/**`). Everything else answers as if the
 * route did not exist: `/api/v1/internal/**` (Telegram Serverless, service-signed only), the
 * storefront's catalog, cart and checkout routes, and the Mini App sign-in
 * (`auth/telegram/init-data`), whose replayable `initData` must never mint a back-office session.
 * Matching is exact and case-sensitive, which is what Core API routes on, so no spelling variant
 * can slip past the list and still be forwarded.
 */
export const ALLOWED_AUTH_ROUTES: readonly string[] = [
  'auth/config',
  'auth/session',
  'auth/logout',
  OIDC_START_PATH,
  OIDC_CALLBACK_PATH,
];

function isAllowedPath(segments: readonly string[]): boolean {
  if (segments[0] === 'admin') return true;
  return ALLOWED_AUTH_ROUTES.includes(segments.join('/'));
}

/**
 * Whether a failed attempt may be sent again. Provably safe only for:
 *
 * - `GET` (reads; the admin API has no state-changing GET), except the OIDC callback: it consumes
 *   the one-time `state`, so a second try could only fail;
 * - `POST auth/telegram/oidc/start`: its only effects are a new one-time sign-in state row and a
 *   binding cookie returned with the response. A failed attempt's state is unusable (its binding
 *   cookie never reaches the browser and the row expires with its TTL), so trying again cannot
 *   sign anyone in twice or reuse anything; at worst it counts once more against the login rate
 *   limit.
 *
 * Every other write (orders, catalog, users, logout, ...) is never retried here.
 */
export function isRetryable(method: string, route: string): boolean {
  if (method === 'GET') return route !== OIDC_CALLBACK_PATH;
  return method === 'POST' && route === OIDC_START_PATH;
}

function cookieValue(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

/**
 * Where a failed OIDC callback sends the browser: the sign-in page of the visitor's locale with a
 * coarse status (the same set the Core API uses) and the support code, instead of a raw JSON error
 * page in the middle of a top-level navigation.
 */
export function callbackFailureLocation(
  request: Request,
  status: TelegramOidcFailureStatus,
  requestId: string,
): string {
  const locale = negotiateLocale({
    cookie: cookieValue(request.headers.get('cookie'), LOCALE_COOKIE),
    acceptLanguage: request.headers.get('accept-language'),
  });
  const params = new URLSearchParams({ status });
  const code = supportCodeFor(requestId);
  if (code !== null) params.set('ref', code);
  return `/${locale}/auth/telegram?${params.toString()}`;
}

function callbackFailureRedirect(
  request: Request,
  status: TelegramOidcFailureStatus,
  requestId: string,
): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: callbackFailureLocation(request, status, requestId),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      [REQUEST_ID_HEADER]: requestId,
    },
  });
}

function buildUpstreamHeaders(
  request: Request,
  clientIpHeader: string | null,
  requestId: string,
): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // A browser-sent `x-forwarded-for` is never passed on (it would let anyone pick their own
  // rate-limit bucket); see `clientIpFrom`.
  const clientIp = clientIpFrom(request.headers, clientIpHeader);
  if (clientIp !== null) headers.set('x-forwarded-for', clientIp);
  headers.set('x-mm-entrance', ENTRANCE);
  // Ours, never the browser's: one id per proxied request, shared with the gateway and the API.
  headers.set(REQUEST_ID_HEADER, requestId);
  return headers;
}

/**
 * Reads the request body up to `limit` bytes. Returns `null` when the limit is exceeded, without
 * buffering more than `limit + one chunk`.
 */
async function readBodyCapped(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (request.body === null) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Passes the OIDC callback's `303` through: only `Location` (when it is a safe relative path), the
 * cookies, and no-store / no-referrer. Anything else (another status, an absolute or odd
 * `Location`) sends the browser to the sign-in page with `status=unavailable` instead.
 */
function oidcCallbackRedirect(request: Request, upstream: Response, requestId: string): Response {
  const location = upstream.headers.get('location');
  if (upstream.status !== 303 || location === null || !isSafeRelativeLocation(location)) {
    logUpstreamFailure({
      request_id: requestId,
      route: OIDC_CALLBACK_PATH,
      reason: 'unexpected_redirect',
      status: upstream.status,
    });
    return callbackFailureRedirect(request, 'unavailable', requestId);
  }
  const headers = new Headers({
    location,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    [REQUEST_ID_HEADER]: requestId,
  });
  for (const cookie of upstream.headers.getSetCookie()) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

type Attempt = { kind: 'response'; response: Response } | { kind: 'timeout' } | { kind: 'network' };

/** Creates the Route Handler shared by every HTTP method of the admin's `/api/v1/[...path]`. */
export function createApiProxy(deps: ProxyDeps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const makeRequestId = deps.requestId ?? newRequestId;

  return async function handle(request: Request, context: ProxyRouteContext): Promise<Response> {
    const { path } = await context.params;

    if (hasUnsafeSegment(path) || !isAllowedPath(path)) {
      return errorResponse(404, 'not_found', 'Not Found');
    }

    const requestId = makeRequestId();
    const method = request.method.toUpperCase();
    const route = path.join('/');
    const isCallback = method === 'GET' && route === OIDC_CALLBACK_PATH;
    const hasBody = method !== 'GET' && method !== 'HEAD';

    let body: Uint8Array | undefined;
    if (hasBody) {
      const read = await readBodyCapped(request, bodyLimitFor(method, path));
      if (read === null) {
        return errorResponse(413, 'payload_too_large', 'Request body is too large', requestId);
      }
      // Empty body (e.g. DELETE, logout) is sent as no body at all.
      if (read.byteLength > 0) body = read;
    }

    const search = new URL(request.url).search;
    const target =
      `${deps.apiBaseUrl()}${API_V1_PREFIX}/` +
      path.map((segment) => encodeURIComponent(segment)).join('/') +
      search;
    const headers = buildUpstreamHeaders(request, deps.clientIpHeader?.() ?? null, requestId);

    const started = now();
    const deadline = started + UPSTREAM_TIMEOUT_MS;
    const attemptOnce = async (): Promise<Attempt> => {
      try {
        const response = await deps.fetch(target, {
          method,
          headers,
          ...(body === undefined ? {} : { body: body as BodyInit }),
          // Never follow redirects on behalf of the browser and never reuse a cached response.
          redirect: 'manual',
          cache: 'no-store',
          signal: AbortSignal.timeout(Math.max(1, deadline - now())),
        });
        return { kind: 'response', response };
      } catch (error) {
        return error instanceof DOMException && error.name === 'TimeoutError'
          ? { kind: 'timeout' }
          : { kind: 'network' };
      }
    };

    let attempt = await attemptOnce();
    let attempts = 1;
    const failedRetryably =
      attempt.kind === 'network' ||
      (attempt.kind === 'response' && RETRYABLE_STATUSES.has(attempt.response.status));
    if (
      failedRetryably &&
      isRetryable(method, route) &&
      deadline - now() - RETRY_DELAY_MS >= MIN_RETRY_BUDGET_MS
    ) {
      if (attempt.kind === 'response') await attempt.response.body?.cancel();
      await sleep(RETRY_DELAY_MS);
      attempt = await attemptOnce();
      attempts = 2;
    }

    if (attempt.kind !== 'response') {
      logUpstreamFailure({
        request_id: requestId,
        route,
        method,
        reason: attempt.kind,
        attempts,
        duration_ms: now() - started,
      });
      if (isCallback) return callbackFailureRedirect(request, 'unavailable', requestId);
      return attempt.kind === 'timeout'
        ? errorResponse(
            504,
            'service_unavailable',
            'The service took too long to respond',
            requestId,
          )
        : errorResponse(502, 'service_unavailable', 'The service is unavailable', requestId);
    }

    const upstream = attempt.response;
    const upstreamId = parseRequestId(upstream.headers.get(REQUEST_ID_HEADER)) ?? requestId;
    if (upstream.status >= 500) {
      logUpstreamFailure({
        request_id: upstreamId,
        route,
        method,
        reason: 'upstream_status',
        status: upstream.status,
        attempts,
        duration_ms: now() - started,
      });
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      if (isCallback) return oidcCallbackRedirect(request, upstream, upstreamId);
      // Any other redirect would point the browser at the internal API host; the API does not
      // redirect on purpose, so treat one as a misbehaving upstream.
      await upstream.body?.cancel();
      logUpstreamFailure({ request_id: upstreamId, route, reason: 'unexpected_redirect' });
      return errorResponse(
        502,
        'service_unavailable',
        'Unexpected response from the service',
        upstreamId,
      );
    }

    if (isCallback) {
      // The callback is a top-level navigation: never show the browser a JSON error page. A rate
      // limit or an outage reads as "unavailable", anything else as "failed".
      await upstream.body?.cancel();
      const status = upstream.status === 429 || upstream.status >= 500 ? 'unavailable' : 'failed';
      return callbackFailureRedirect(request, status, upstreamId);
    }

    const responseHeaders = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) responseHeaders.set(name, value);
    }
    const cookies = upstream.headers.getSetCookie();
    for (const cookie of cookies) responseHeaders.append('set-cookie', cookie);
    // Anything that sets a cookie, or that the API did not mark cacheable, must not be stored.
    if (cookies.length > 0 || !responseHeaders.has('cache-control')) {
      responseHeaders.set('cache-control', 'no-store');
    }
    responseHeaders.set(REQUEST_ID_HEADER, upstreamId);

    const noBody = upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
    return new Response(noBody ? null : upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  };
}

/**
 * The proxy wired to `API_INTERNAL_URL` through `upstreamFetch` (global `fetch` under Next.js,
 * the `CORE_API` service binding on Cloudflare Workers).
 */
export const apiProxy = createApiProxy({
  fetch: (...args) => upstreamFetch(...args),
  apiBaseUrl: getApiInternalUrl,
  clientIpHeader: getClientIpHeader,
});
