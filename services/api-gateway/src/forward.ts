import {
  type Entrance,
  errorResponse,
  functionOrigin,
  isAllowed,
  isOidcCallback,
  isSafeRelativeLocation,
  requestIdFor,
  singleIp,
  upstreamHeaders,
  upstreamUrl,
} from './routing';

/**
 * Forwarding to the Core API Neon Function. No Workers-only APIs, so it runs under plain Vitest
 * (test/forward.test.ts: normal, timeout, bad secret, spoofed headers).
 */

/**
 * Timeout budget, innermost first (each layer must give up before the one outside it, so the
 * caller always sees the inner layer's precise error instead of its own blind timeout):
 *
 * - Function: `pg` connect 10 s (`db.ts`), statement 15 s, Telegram HTTP 10 s (`telegram/oidc.ts`);
 *   a request that wakes a scaled-to-zero Function and a suspended Postgres compute spends a few
 *   seconds of that on cold start.
 * - Gateway (here): 20 s per request.
 * - Admin / web proxy: more than this (the admin's is 25 s, `apps/admin/src/lib/api/api-proxy.ts`).
 */
export const UPSTREAM_TIMEOUT_MS = 20_000;
// The scheduler entrance waits for a whole outbox drain (bounded in the Function).
export const SCHEDULER_TIMEOUT_MS = 60_000;

export function log(
  level: 'info' | 'error',
  message: string,
  fields: Record<string, unknown> = {},
) {
  const line = JSON.stringify({ level, msg: message, service: 'api-gateway', ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

export interface ForwardDeps {
  env: { CORE_API_FUNCTION_ORIGIN?: string; CORE_API_FUNCTION_SECRET?: string };
  fetch: (request: Request) => Promise<Response>;
  /** Overrides for tests. */
  timeouts?: { upstreamMs: number; schedulerMs: number };
}

export async function forward(
  request: Request,
  deps: ForwardDeps,
  entrance: Entrance,
): Promise<Response> {
  const url = new URL(request.url);
  if (!isAllowed(entrance, request.method, url.pathname)) {
    return errorResponse(404, 'not_found', 'Not Found');
  }

  const origin = functionOrigin(deps.env.CORE_API_FUNCTION_ORIGIN);
  const secret = deps.env.CORE_API_FUNCTION_SECRET ?? '';
  if (origin === null || new TextEncoder().encode(secret).length < 32) {
    // Misconfiguration: fail closed without saying which value is wrong.
    log('error', 'core api function is not configured', { entrance });
    return errorResponse(503, 'service_unavailable', 'Service unavailable');
  }

  const clientIp =
    entrance === 'public'
      ? singleIp(request.headers.get('cf-connecting-ip'))
      : entrance === 'scheduler'
        ? null
        : singleIp(request.headers.get('x-forwarded-for'));
  const requestId = requestIdFor(
    entrance,
    request.headers,
    request.headers.get('cf-ray') ?? crypto.randomUUID(),
  );
  const headers = upstreamHeaders(request.headers, {
    entrance,
    clientIp,
    fallbackRequestId: requestId,
    gatewaySecret: secret,
  });

  const method = request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const timeoutMs =
    entrance === 'scheduler'
      ? (deps.timeouts?.schedulerMs ?? SCHEDULER_TIMEOUT_MS)
      : (deps.timeouts?.upstreamMs ?? UPSTREAM_TIMEOUT_MS);
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers,
    // Streamed as-is: the service signature covers the exact body bytes (ADR 0003).
    body: hasBody ? request.body : null,
    // Never follow a redirect with the secret attached.
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  };
  // Node (tests) needs `duplex` for a streamed body; the Workers runtime ignores it.
  if (hasBody) init.duplex = 'half';
  const upstream = new Request(upstreamUrl(origin, url), init);
  const started = Date.now();

  let response: Response;
  try {
    response = await deps.fetch(upstream);
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    log('error', 'upstream request failed', {
      entrance,
      timedOut,
      request_id: requestId,
      duration_ms: Date.now() - started,
    });
    return timedOut
      ? errorResponse(504, 'service_unavailable', 'The service took too long to respond', requestId)
      : errorResponse(502, 'service_unavailable', 'The service is unavailable', requestId);
  }

  if (response.status >= 300 && response.status < 400) {
    if (isOidcCallback(entrance, method, url.pathname)) {
      return oidcCallbackRedirect(response, entrance, requestId);
    }
    // The Function never redirects across origins; do not hand a redirect to a browser.
    await response.body?.cancel();
    log('error', 'upstream redirect refused', {
      entrance,
      status: response.status,
      request_id: requestId,
    });
    return errorResponse(502, 'service_unavailable', 'The service is unavailable', requestId);
  }
  if (response.status === 401) {
    // Only a wrong or missing gateway secret produces a bare 401 from the Function's edge
    // middleware; log it (no values) so a rotation mistake is visible.
    log('error', 'upstream rejected the request', {
      entrance,
      status: 401,
      request_id: requestId,
    });
  }
  return withRequestId(response, requestId);
}

/**
 * The Function's own `X-Request-ID` wins (it is the same id unless the Function generated one);
 * otherwise ours is added. Responses from `fetch` have immutable headers, so this rebuilds it.
 */
function withRequestId(response: Response, requestId: string): Response {
  if (response.headers.has('x-request-id')) return response;
  const headers = new Headers(response.headers);
  headers.set('x-request-id', requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Passes the end of the Telegram OIDC sign-in through (ADR 0014): exactly `303` with a safe,
 * same-origin, path-absolute `Location`, plus the cookies the Function set (the session on
 * success, the expired binding cookie always). Anything else (another status, an absolute or
 * odd `Location`) is refused with 502 like every other redirect.
 *
 * Before this existed every callback was refused, so in deployed environments each "Sign in
 * with Telegram" ended on a raw `service_unavailable` JSON page right after Telegram (the app
 * proxies call the Function directly in local development and E2E, so they never saw it).
 */
function oidcCallbackRedirect(response: Response, entrance: Entrance, requestId: string): Response {
  const location = response.headers.get('location');
  if (response.status !== 303 || location === null || !isSafeRelativeLocation(location)) {
    void response.body?.cancel();
    log('error', 'upstream redirect refused', {
      entrance,
      status: response.status,
      request_id: requestId,
      route: 'oidc_callback',
    });
    return errorResponse(502, 'service_unavailable', 'The service is unavailable', requestId);
  }
  void response.body?.cancel();
  const headers = new Headers({
    location,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-request-id': response.headers.get('x-request-id') ?? requestId,
  });
  for (const cookie of response.headers.getSetCookie()) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}
