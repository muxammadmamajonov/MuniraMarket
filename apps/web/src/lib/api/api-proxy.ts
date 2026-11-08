import 'server-only';
import { API_V1_PREFIX } from '@muniramarket/contracts';
import { getApiInternalUrl, getClientIpHeader } from '@/lib/config';
import { clientIpFrom } from './client-ip';
import { upstreamFetch } from './upstream-fetch';

/** Largest request body the proxy forwards. The API's own limit is at least as strict. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * How long we wait for the Core API before answering 504. Longer than the API gateway's own
 * 20 s budget (which covers a Neon Function cold start), so the gateway answers first and the
 * proxy never cuts off a request that would have succeeded.
 */
export const UPSTREAM_TIMEOUT_MS = 25_000;

/**
 * Which entrance this app is, sent to the Core API as `x-mm-entrance` on every upstream request.
 * In production the Cloudflare gateway sets the same header; locally (and in E2E) there is no
 * gateway, so the proxy sets it. A browser-sent `x-mm-entrance` is never forwarded: it is not in
 * {@link FORWARDED_REQUEST_HEADERS} and is always overwritten here.
 */
export const ENTRANCE = 'storefront';

/**
 * The only upstream redirect passed through to the browser: the end of the Telegram OIDC sign-in.
 * The Core API answers it with `303` and a relative `Location` (the `return_to` page, or the
 * sign-in failure page), plus the session cookie on success.
 */
const OIDC_CALLBACK_PATH = 'auth/telegram/oidc/callback';

/**
 * `true` for a same-origin, path-absolute `Location` such as `/uz/orders?x=1`: it starts with a
 * single `/` (not `//`, which is protocol-relative), has no backslash (browsers treat `/\` like
 * `//`), no control characters or spaces, and still resolves to the same origin.
 */
export function isSafeRelativeLocation(location: string): boolean {
  if (location.length === 0 || location.length > 2048) return false;
  if (!location.startsWith('/') || location.startsWith('//')) return false;
  // Control characters (including tab/CR/LF, which URL parsing strips), DEL, space, backslash.
  if (/[\u0000-\u0020\u007f\\]/.test(location)) return false;
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
  // Lets `POST /orders` be retried safely: the API answers a repeat of the same key and body with
  // the original order instead of creating a second one.
  'idempotency-key',
  'origin',
  'user-agent',
] as const;

/** Response headers returned to the browser. `set-cookie` is handled separately (multi-value). */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'retry-after',
  'cache-control',
  // `true` when `POST /orders` was a replay of an earlier request with the same key.
  'idempotent-replayed',
] as const;

export interface ProxyDeps {
  fetch: typeof fetch;
  /** Core API base URL, no trailing slash. */
  apiBaseUrl: () => string;
  /** Edge-set header holding the real client IP, or `null` (see `getClientIpHeader`). */
  clientIpHeader?: () => string | null;
}

export interface ProxyRouteContext {
  params: Promise<{ path: string[] }>;
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { 'cache-control': 'no-store' } },
  );
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
 * Route groups the storefront never serves, so the proxy answers as if they did not exist:
 *
 * - `/api/v1/internal/**` is for Telegram Serverless (service-signed requests) only;
 * - `/api/v1/admin/**` is the back office, which has its own app (`apps/admin`). The Core API
 *   enforces roles anyway; this is defence in depth, so a customer-facing origin never even
 *   forwards such a request.
 */
const UNSERVED_ROUTE_GROUPS: ReadonlySet<string> = new Set(['internal', 'admin']);

function isUnservedPath(segments: readonly string[]): boolean {
  return UNSERVED_ROUTE_GROUPS.has(segments[0]?.toLowerCase() ?? '');
}

function buildUpstreamHeaders(request: Request, clientIpHeader: string | null): Headers {
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
 * `Location`) answers 502 like every other redirect.
 */
function oidcCallbackRedirect(upstream: Response): Response {
  const location = upstream.headers.get('location');
  if (upstream.status !== 303 || location === null || !isSafeRelativeLocation(location)) {
    return errorResponse(502, 'service_unavailable', 'Unexpected response from the service');
  }
  const headers = new Headers({
    location,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  for (const cookie of upstream.headers.getSetCookie()) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

/** Creates the Route Handler shared by every HTTP method of `/api/v1/[...path]`. */
export function createApiProxy(deps: ProxyDeps) {
  return async function handle(request: Request, context: ProxyRouteContext): Promise<Response> {
    const { path } = await context.params;

    if (hasUnsafeSegment(path) || isUnservedPath(path)) {
      return errorResponse(404, 'not_found', 'Not Found');
    }

    const method = request.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';

    let body: Uint8Array | undefined;
    if (hasBody) {
      const read = await readBodyCapped(request, MAX_BODY_BYTES);
      if (read === null) {
        return errorResponse(413, 'payload_too_large', 'Request body is too large');
      }
      // Empty body (e.g. DELETE, logout) is sent as no body at all.
      if (read.byteLength > 0) body = read;
    }

    const search = new URL(request.url).search;
    const target =
      `${deps.apiBaseUrl()}${API_V1_PREFIX}/` +
      path.map((segment) => encodeURIComponent(segment)).join('/') +
      search;

    let upstream: Response;
    try {
      upstream = await deps.fetch(target, {
        method,
        headers: buildUpstreamHeaders(request, deps.clientIpHeader?.() ?? null),
        ...(body === undefined ? {} : { body: body as BodyInit }),
        // Never follow redirects on behalf of the browser and never reuse a cached response.
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        return errorResponse(504, 'service_unavailable', 'The service took too long to respond');
      }
      return errorResponse(502, 'service_unavailable', 'The service is unavailable');
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      if (method === 'GET' && path.join('/') === OIDC_CALLBACK_PATH) {
        return oidcCallbackRedirect(upstream);
      }
      // Any other redirect would point the browser at the internal API host; the API does not
      // redirect on purpose, so treat one as a misbehaving upstream.
      return errorResponse(502, 'service_unavailable', 'Unexpected response from the service');
    }

    const headers = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const cookies = upstream.headers.getSetCookie();
    for (const cookie of cookies) headers.append('set-cookie', cookie);
    // Anything that sets a cookie, or that the API did not mark cacheable, must not be stored.
    if (cookies.length > 0 || !headers.has('cache-control')) {
      headers.set('cache-control', 'no-store');
    }

    const noBody = upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
    return new Response(noBody ? null : upstream.body, { status: upstream.status, headers });
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
