/**
 * Pure request policy of the Core API gateway: which paths each entrance may reach and which
 * headers reach the Core API Neon Function. No Workers APIs here, so it runs under plain Vitest.
 *
 * Four entrances (see README.md):
 *
 * - `public`: the Worker's own hostname, reached from the internet. Only liveness/readiness and
 *   the service-signed routes Telegram Serverless calls (ADR 0003): user sync
 *   (`internal/telegram/session`), staff group connect (`internal/telegram/staff-chat/connect`),
 *   the onboarding language (`PUT internal/telegram/language`) and the user's own contact
 *   (`POST internal/telegram/phone`).
 * - `storefront`: the `StorefrontApi` entrypoint, reachable only through the web Worker's service
 *   binding. Everything the storefront proxy forwards, never `admin/**` or `internal/**`.
 * - `admin`: the `AdminApi` entrypoint, reachable only through the admin Worker's service
 *   binding. `admin/**` plus the Telegram OIDC sign-in and session routes, mirroring
 *   `apps/admin/src/lib/api/api-proxy.ts`.
 * - `scheduler`: never reachable from outside. Used only by this Worker's own Cron Trigger
 *   (`scheduled()` in index.ts), which only signs two POSTs: `internal/scheduler/notifications/drain`
 *   (the Function drains the outbox and talks to the Bot API) and `internal/maintenance/cleanup`.
 *
 * Each app proxy already enforces its own list; this is the second, independent fence, so a bug
 * in one app cannot widen what reaches the API.
 */

export type Entrance = 'public' | 'storefront' | 'admin' | 'scheduler';

export const API_PREFIX = '/api/v1';

const ADMIN_AUTH_ROUTES: ReadonlySet<string> = new Set([
  'auth/config',
  'auth/session',
  'auth/logout',
  'auth/telegram/oidc/start',
  'auth/telegram/oidc/callback',
]);

/** The only routes the Cron Trigger calls (signed, empty actor). */
const SCHEDULER_ROUTES: ReadonlySet<string> = new Set([
  'internal/scheduler/notifications/drain',
  'internal/maintenance/cleanup',
]);

/** The only routes Telegram Serverless calls through the public hostname, with their method. */
const TELEGRAM_PUBLIC_ROUTES: ReadonlyMap<string, string> = new Map([
  ['internal/telegram/session', 'POST'],
  ['internal/telegram/staff-chat/connect', 'POST'],
  // Bot onboarding language choice and the user's own shared contact (ADR 0003, signed).
  ['internal/telegram/language', 'PUT'],
  ['internal/telegram/phone', 'POST'],
]);

const HEALTH_ROUTES: ReadonlySet<string> = new Set(['health', 'health/ready']);

/**
 * Path segments below `/api/v1/`, or `null` when the path is outside it or contains a segment
 * that could change meaning once forwarded (empty, dot segments, encoded separators).
 */
export function apiSegments(pathname: string): string[] | null {
  if (!pathname.startsWith(`${API_PREFIX}/`)) return null;
  const rest = pathname.slice(API_PREFIX.length + 1);
  const raw = rest.split('/');
  const segments: string[] = [];
  for (const segment of raw) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (
      decoded === '' ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      decoded.includes('\0')
    ) {
      return null;
    }
    segments.push(decoded);
  }
  return segments;
}

/** Whether `method pathname` may pass through `entrance`. Exact, case-sensitive matching. */
export function isAllowed(entrance: Entrance, method: string, pathname: string): boolean {
  const segments = apiSegments(pathname);
  if (segments === null) return false;
  const route = segments.join('/');
  const upper = method.toUpperCase();

  // Exactly two POST routes; not even the health checks.
  if (entrance === 'scheduler') return upper === 'POST' && SCHEDULER_ROUTES.has(route);

  // GET only: the API's health routes do not answer HEAD.
  if (HEALTH_ROUTES.has(route)) return upper === 'GET';

  switch (entrance) {
    case 'public':
      // Telegram Serverless calls only these signed routes, each with one method.
      return TELEGRAM_PUBLIC_ROUTES.get(route) === upper;
    case 'storefront':
      return segments[0] !== 'admin' && segments[0] !== 'internal';
    case 'admin':
      return segments[0] === 'admin' || ADMIN_AUTH_ROUTES.has(route);
  }
}

/**
 * Request headers the Function may see. Anything else (Host, CF-*, X-Forwarded-*, and above all
 * `X-MM-Gateway-Secret`, which only this Worker sets) is dropped, so a caller cannot spoof them.
 */
const FORWARDED_HEADERS: Readonly<Record<Entrance, readonly string[]>> = {
  public: [
    'content-type',
    'accept',
    'user-agent',
    // ADR 0003 service signature.
    'x-mm-key-id',
    'x-mm-timestamp',
    'x-mm-nonce',
    'x-mm-signature',
    'x-mm-actor',
  ],
  storefront: [
    'content-type',
    'accept',
    'accept-language',
    'cookie',
    'x-csrf-token',
    'idempotency-key',
    'origin',
    'referer',
    'user-agent',
  ],
  admin: [
    'content-type',
    'accept',
    'accept-language',
    'cookie',
    'x-csrf-token',
    'origin',
    'referer',
    'user-agent',
  ],
  // Built by this Worker itself: the signature headers and the body type, nothing else.
  scheduler: [
    'content-type',
    'accept',
    'x-mm-key-id',
    'x-mm-timestamp',
    'x-mm-nonce',
    'x-mm-signature',
    'x-mm-actor',
  ],
};

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-f:]{2,39}$/i;

/** A single, syntactically valid IP address, else `null`. */
export function singleIp(value: string | null): string | null {
  const text = value?.trim() ?? '';
  if (IPV4.test(text)) return text;
  if (IPV6.test(text) && text.includes(':')) return text.toLowerCase();
  return null;
}

const REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export interface UpstreamContext {
  entrance: Entrance;
  /**
   * The visitor's IP: `CF-Connecting-IP` on the public entrance; on a service-binding entrance,
   * the `X-Forwarded-For` the calling app set from its own `CF-Connecting-IP`; always `null` on
   * the scheduler entrance (there is no client).
   */
  clientIp: string | null;
  /** Fallback request id when the caller sent none (the Cloudflare ray id, or a UUID). */
  fallbackRequestId: string;
}

/** Header carrying the gateway -> Function shared secret (`CORE_API_FUNCTION_SECRET`). */
export const GATEWAY_SECRET_HEADER = 'x-mm-gateway-secret';

/**
 * Headers for the Function request, built from an allow-list (never a copy of the incoming
 * headers). `X-Forwarded-For`, `X-MM-Entrance`, `X-Request-ID` and the gateway secret are always
 * written here, so the Function only ever sees values this gateway set.
 */
export function upstreamHeaders(
  incoming: Headers,
  context: UpstreamContext & { gatewaySecret: string },
): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS[context.entrance]) {
    const value = incoming.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (context.clientIp !== null && context.entrance !== 'scheduler') {
    headers.set('x-forwarded-for', context.clientIp);
  }
  // Gateway-owned routing metadata, never a browser header, set on EVERY upstream request
  // (whatever the caller sent is dropped above). The Core API uses it to pick the Telegram OIDC
  // redirect origin (storefront vs admin public origin) and to bind browser sessions to the
  // entrance they were created on, so a storefront session cannot be replayed on the admin.
  // The Function rejects any request without the gateway secret.
  headers.set('x-mm-entrance', context.entrance);
  headers.set(GATEWAY_SECRET_HEADER, context.gatewaySecret);
  const requestId = incoming.get('x-request-id');
  const callerMayChooseId = context.entrance === 'storefront' || context.entrance === 'admin';
  headers.set(
    'x-request-id',
    requestId !== null && REQUEST_ID.test(requestId) && callerMayChooseId
      ? requestId
      : context.fallbackRequestId,
  );
  return headers;
}

/** The JSON error envelope the Core API uses, so clients see one shape. */
export function errorResponse(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * The Function's origin (`https://<branch>-coreapi.compute.<cell>...neon.tech`) from the
 * `CORE_API_FUNCTION_ORIGIN` secret, or `null` when it is missing or not a bare https origin.
 * The upstream URL is always built from this origin plus the request's path and query, assigned
 * separately, so a request path can never change the authority.
 */
export function functionOrigin(raw: string | undefined): string | null {
  let url: URL;
  try {
    url = new URL((raw ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    return null;
  }
  if (url.pathname !== '/' && url.pathname !== '') return null;
  return url.origin;
}

export function upstreamUrl(origin: string, requestUrl: URL): URL {
  const upstream = new URL(origin);
  upstream.pathname = requestUrl.pathname;
  upstream.search = requestUrl.search;
  return upstream;
}
