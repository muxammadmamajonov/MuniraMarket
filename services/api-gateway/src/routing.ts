/**
 * Pure request policy of the Core API gateway: which paths each entrance may reach and which
 * headers reach the container. No Workers APIs here, so it runs under plain Vitest.
 *
 * Three entrances (see README.md):
 *
 * - `public`: the Worker's own hostname, reached from the internet. Only liveness/readiness and
 *   the service-signed Telegram Serverless routes (`/api/v1/internal/telegram/**`, ADR 0003).
 * - `storefront`: the `StorefrontApi` entrypoint, reachable only through the web Worker's service
 *   binding. Everything the storefront proxy forwards, never `admin/**` or `internal/**`.
 * - `admin`: the `AdminApi` entrypoint, reachable only through the admin Worker's service
 *   binding. `admin/**` plus the Login Widget sign-in and session routes, mirroring
 *   `apps/admin/src/lib/api/api-proxy.ts`.
 *
 * Each app proxy already enforces its own list; this is the second, independent fence, so a bug
 * in one app cannot widen what reaches the API.
 */

export type Entrance = 'public' | 'storefront' | 'admin';

export const API_PREFIX = '/api/v1';

const ADMIN_AUTH_ROUTES: ReadonlySet<string> = new Set([
  'auth/config',
  'auth/session',
  'auth/logout',
  'auth/telegram/login-widget',
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

  // GET only: the API's health routes do not answer HEAD.
  if (HEALTH_ROUTES.has(route)) return upper === 'GET';

  switch (entrance) {
    case 'public':
      // Telegram Serverless calls only signed POSTs (claim/result, user sync).
      return upper === 'POST' && segments[0] === 'internal' && segments[1] === 'telegram';
    case 'storefront':
      return segments[0] !== 'admin' && segments[0] !== 'internal';
    case 'admin':
      return segments[0] === 'admin' || ADMIN_AUTH_ROUTES.has(route);
  }
}

/** Request headers the container may see. Anything else (Host, CF-*, X-Forwarded-*) is dropped. */
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
   * the `X-Forwarded-For` the calling app set from its own `CF-Connecting-IP`.
   */
  clientIp: string | null;
  /** Fallback request id when the caller sent none (the Cloudflare ray id, or a UUID). */
  fallbackRequestId: string;
}

/**
 * Headers for the container request. `X-Forwarded-For` is always written here (or removed), so
 * the API's proxy-header trust (`FORWARDED_ALLOW_IPS`) only ever sees a value this gateway set.
 */
export function upstreamHeaders(incoming: Headers, context: UpstreamContext): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS[context.entrance]) {
    const value = incoming.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (context.clientIp !== null) headers.set('x-forwarded-for', context.clientIp);
  const requestId = incoming.get('x-request-id');
  headers.set(
    'x-request-id',
    requestId !== null && REQUEST_ID.test(requestId) && context.entrance !== 'public'
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

/** Picks one of `count` interchangeable container instances. */
export function instanceName(count: number, random: () => number = Math.random): string {
  const size = Number.isInteger(count) && count > 0 ? count : 1;
  return `core-api-${Math.min(size - 1, Math.floor(random() * size))}`;
}
