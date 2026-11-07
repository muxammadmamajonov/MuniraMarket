import { Hono } from 'hono';
import { ApiError, apiErrorResponse, errorJson, StoreUnavailableError } from './errors.ts';
import { API_PREFIX } from './http/body.ts';
import type { AppBindings, Deps, Entrance } from './http/context.ts';
import { createGatewaySecretCheck } from './http/gatewaySecret.ts';
import { errorFields, REQUEST_ID_PATTERN } from './logging.ts';
import { registerRoutes } from './routes/index.ts';

/**
 * The Core API as one Hono app (the Function's default export is `createApp(deps)`).
 *
 * Middleware order mirrors services/api/app/main.py:
 * 1. request id + one access-log line (method, route template, status, duration; never the IP,
 *    query string, headers, cookies or body);
 * 2. gateway secret: anything without `X-MM-Gateway-Secret` is 401 before any other work;
 * 3. queued session cookies and `Cache-Control: no-store` on every response under the
 *    session-bound prefixes or carrying a cookie, errors included;
 * 4. routes; unknown paths 404, known paths with another method 405, uncaught errors 500.
 */

const NO_STORE_PREFIXES = ['auth', 'cart', 'checkout', 'orders', 'admin', 'internal'].map(
  (segment) => `${API_PREFIX}/${segment}`,
);
const QUIET_PATHS = new Set([`${API_PREFIX}/health`]);
const ENTRANCES: ReadonlySet<string> = new Set(['public', 'storefront', 'admin', 'scheduler']);
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-f:]{2,39}$/i;

function isUnder(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** The gateway always writes a single, validated IP (or nothing for the scheduler). */
function clientIpFrom(headers: Headers): string {
  const value = headers.get('x-forwarded-for')?.trim() ?? '';
  if (IPV4.test(value)) return value;
  if (IPV6.test(value) && value.includes(':')) return value.toLowerCase();
  return 'unknown';
}

export function createApp(deps: Deps): Hono<AppBindings> {
  const hasGatewaySecret = createGatewaySecretCheck(deps.settings.functionSecret);
  const app = new Hono<AppBindings>();
  const log = deps.logger;

  app.use('*', async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const requestId =
      incoming !== undefined && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : crypto.randomUUID().replaceAll('-', '');
    c.set('requestId', requestId);
    const started = performance.now();
    await next();
    c.res.headers.set('x-request-id', requestId);
    const status = c.res.status;
    if (!QUIET_PATHS.has(c.req.path) || status >= 400) {
      const route = c.get('routeTemplate') ?? '<unmatched>';
      log.info(`${c.req.method} ${route} ${status}`, {
        event: 'http_request',
        request_id: requestId,
        method: c.req.method,
        route,
        status,
        duration_ms: Math.round((performance.now() - started) * 10) / 10,
      });
    }
  });

  app.use('*', async (c, next) => {
    if (!hasGatewaySecret(c.req.raw.headers)) {
      // Same envelope as every other error; nothing about why is revealed.
      c.res = errorJson(401, 'unauthorized', 'Unauthorized', {
        headers: { 'cache-control': 'no-store' },
      });
      return;
    }
    const entrance = c.req.header('x-mm-entrance') ?? 'public';
    c.set('deps', deps);
    c.set('entrance', (ENTRANCES.has(entrance) ? entrance : 'public') as Entrance);
    c.set('clientIp', clientIpFrom(c.req.raw.headers));
    c.set('queuedCookies', new Map());
    await next();
    const cookies = c.get('queuedCookies');
    if (cookies.size > 0 || isUnder(c.req.path, NO_STORE_PREFIXES)) {
      // Rebuild: a Response produced by c.json() may have immutable headers in some runtimes.
      const headers = new Headers(c.res.headers);
      for (const cookie of cookies.values()) headers.append('set-cookie', cookie);
      headers.set('cache-control', 'no-store');
      c.res = new Response(c.res.body, { status: c.res.status, headers });
    }
  });

  registerRoutes(app);

  const known = app.routes
    .filter((route) => route.method !== 'ALL')
    .map((route) => ({
      method: route.method,
      pattern: new RegExp(`^${route.path.replace(/:[A-Za-z_]+/g, '[^/]+')}$`),
    }));

  app.notFound((c) => {
    const allowed = known.filter((route) => route.pattern.test(c.req.path));
    if (allowed.length > 0) {
      return errorJson(405, 'method_not_allowed', 'Method Not Allowed', {
        headers: { allow: [...new Set(allowed.map((r) => r.method))].join(', ') },
      });
    }
    return errorJson(404, 'not_found', 'Not Found');
  });

  app.onError((error, c) => {
    if (error instanceof ApiError) return apiErrorResponse(error);
    if (error instanceof StoreUnavailableError) {
      log.error('Security store unavailable; failing closed', { route: c.req.path });
      return errorJson(503, 'service_unavailable', 'Service temporarily unavailable');
    }
    log.error(`Unhandled exception on ${c.req.method} ${c.get('routeTemplate') ?? c.req.path}`, {
      request_id: c.get('requestId'),
      ...errorFields(error),
    });
    return errorJson(500, 'internal_error', 'Internal server error', {
      headers: { 'cache-control': 'no-store' },
    });
  });

  return app;
}
