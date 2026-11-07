import { describe, expect, it } from 'vitest';
import {
  apiSegments,
  errorResponse,
  functionOrigin,
  GATEWAY_SECRET_HEADER,
  isAllowed,
  singleIp,
  upstreamHeaders,
  upstreamUrl,
} from '../src/routing';

const SECRET = 'test-only-gateway-secret-0123456789abcdefgh';

describe('apiSegments', () => {
  it('splits paths under /api/v1/', () => {
    expect(apiSegments('/api/v1/orders/abc')).toEqual(['orders', 'abc']);
  });

  it.each([
    '/api/v2/orders',
    '/api/v1',
    '/api/v1/',
    '/api/v1//orders',
    '/api/v1/orders/..',
    '/api/v1/%2e%2e/admin',
    '/api/v1/admin%2Fusers',
    '/api/v1/a%5Cb',
    '/api/v1/a%00b',
    '/api/v1/%E0%A4%A',
  ])('rejects %s', (path) => {
    expect(apiSegments(path)).toBeNull();
  });
});

describe('isAllowed', () => {
  it('lets every entrance reach the health checks with GET only', () => {
    for (const entrance of ['public', 'storefront', 'admin'] as const) {
      expect(isAllowed(entrance, 'GET', '/api/v1/health')).toBe(true);
      expect(isAllowed(entrance, 'GET', '/api/v1/health/ready')).toBe(true);
      expect(isAllowed(entrance, 'HEAD', '/api/v1/health')).toBe(false);
      expect(isAllowed(entrance, 'POST', '/api/v1/health')).toBe(false);
    }
  });

  it('exposes only the two signed Telegram Serverless routes publicly', () => {
    expect(isAllowed('public', 'POST', '/api/v1/internal/telegram/session')).toBe(true);
    expect(isAllowed('public', 'POST', '/api/v1/internal/telegram/staff-chat/connect')).toBe(true);
    expect(isAllowed('public', 'GET', '/api/v1/internal/telegram/session')).toBe(false);
    expect(isAllowed('public', 'GET', '/api/v1/internal/telegram/me')).toBe(false);
    // The outbox is drained inside the Function now; its routes are not public any more.
    expect(isAllowed('public', 'POST', '/api/v1/internal/telegram/notifications/claim')).toBe(
      false,
    );
    expect(isAllowed('public', 'POST', '/api/v1/internal/scheduler/notifications/drain')).toBe(
      false,
    );
    expect(isAllowed('public', 'GET', '/api/v1/products')).toBe(false);
    expect(isAllowed('public', 'POST', '/api/v1/auth/telegram/init-data')).toBe(false);
    expect(isAllowed('public', 'GET', '/api/v1/admin/orders')).toBe(false);
    expect(isAllowed('public', 'GET', '/api/v1/openapi.json')).toBe(false);
  });

  it('keeps the storefront away from admin and internal routes', () => {
    expect(isAllowed('storefront', 'GET', '/api/v1/products')).toBe(true);
    expect(isAllowed('storefront', 'POST', '/api/v1/orders')).toBe(true);
    expect(isAllowed('storefront', 'POST', '/api/v1/auth/telegram/init-data')).toBe(true);
    expect(isAllowed('storefront', 'GET', '/api/v1/admin/orders')).toBe(false);
    expect(isAllowed('storefront', 'POST', '/api/v1/internal/telegram/users/sync')).toBe(false);
    expect(isAllowed('storefront', 'GET', '/api/v1/%61dmin/orders')).toBe(false);
  });

  it('never exposes the maintenance routes publicly or to the apps', () => {
    for (const entrance of ['public', 'storefront', 'admin'] as const) {
      expect(isAllowed(entrance, 'POST', '/api/v1/internal/maintenance/cleanup')).toBe(false);
    }
  });

  it('lets both apps reach the Telegram OIDC sign-in routes', () => {
    for (const entrance of ['storefront', 'admin'] as const) {
      expect(isAllowed(entrance, 'POST', '/api/v1/auth/telegram/oidc/start')).toBe(true);
      expect(isAllowed(entrance, 'GET', '/api/v1/auth/telegram/oidc/callback')).toBe(true);
    }
    expect(isAllowed('public', 'POST', '/api/v1/auth/telegram/oidc/start')).toBe(false);
    expect(isAllowed('public', 'GET', '/api/v1/auth/telegram/oidc/callback')).toBe(false);
  });

  it('gives the admin only back-office and OIDC sign-in routes', () => {
    expect(isAllowed('admin', 'GET', '/api/v1/admin/orders')).toBe(true);
    expect(isAllowed('admin', 'POST', '/api/v1/auth/telegram/login-widget')).toBe(false);
    expect(isAllowed('admin', 'GET', '/api/v1/auth/telegram/oidc/other')).toBe(false);
    expect(isAllowed('admin', 'GET', '/api/v1/auth/session')).toBe(true);
    expect(isAllowed('admin', 'POST', '/api/v1/auth/telegram/init-data')).toBe(false);
    expect(isAllowed('admin', 'GET', '/api/v1/cart')).toBe(false);
    expect(isAllowed('admin', 'POST', '/api/v1/internal/telegram/notifications/claim')).toBe(false);
    expect(isAllowed('admin', 'GET', '/api/v1/Admin/orders')).toBe(false);
  });
});

describe('isAllowed: scheduler entrance', () => {
  const ID = '0b6f3f6e-6a8c-4a47-9d0e-3b1f2c4d5e6f';

  it('allows exactly the drain and the cleanup, POST only', () => {
    expect(isAllowed('scheduler', 'POST', '/api/v1/internal/scheduler/notifications/drain')).toBe(
      true,
    );
    expect(isAllowed('scheduler', 'POST', '/api/v1/internal/maintenance/cleanup')).toBe(true);
    expect(isAllowed('scheduler', 'GET', '/api/v1/internal/scheduler/notifications/drain')).toBe(
      false,
    );
    expect(isAllowed('scheduler', 'GET', '/api/v1/internal/maintenance/cleanup')).toBe(false);
  });

  it.each([
    '/api/v1/health',
    '/api/v1/health/ready',
    '/api/v1/internal/telegram/session',
    '/api/v1/internal/telegram/staff-chat/connect',
    '/api/v1/internal/telegram/notifications/claim',
    `/api/v1/internal/telegram/notifications/${ID}/result`,
    '/api/v1/internal/scheduler/notifications/drain/x',
    '/api/v1/internal/scheduler/notifications',
    `/api/v1/internal/telegram/notifications/${ID}`,
    `/api/v1/internal/telegram/notifications/${ID}/result/x`,
    '/api/v1/internal/maintenance/cleanup/x',
    '/api/v1/internal/maintenance',
    '/api/v1/admin/orders',
    '/api/v1/orders',
    '/api/v1/internal/%6daintenance/cleanup/..',
  ])('refuses POST %s', (path) => {
    expect(isAllowed('scheduler', 'POST', path)).toBe(false);
  });

  it('refuses GET on the health checks too', () => {
    expect(isAllowed('scheduler', 'GET', '/api/v1/health')).toBe(false);
  });
});

describe('singleIp', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    [' 198.51.100.1 ', '198.51.100.1'],
    ['2001:DB8::1', '2001:db8::1'],
  ])('accepts %s', (input, expected) => {
    expect(singleIp(input)).toBe(expected);
  });

  it.each([null, '', '203.0.113.7, 10.0.0.1', '999.1.1.1', 'unknown', '1.2.3'])(
    'rejects %s',
    (input) => {
      expect(singleIp(input)).toBeNull();
    },
  );
});

describe('upstreamHeaders', () => {
  const incoming = () =>
    new Headers({
      'content-type': 'application/json',
      cookie: '__Host-mm_session=abc',
      'x-csrf-token': 'csrf',
      'x-forwarded-for': '6.6.6.6',
      'x-real-ip': '6.6.6.6',
      'cf-connecting-ip': '203.0.113.7',
      host: 'evil.example',
      'x-request-id': 'req-from-app-0001',
      'x-mm-signature': 'sig',
    });

  it('drops browser cookies and spoofable headers on the public entrance', () => {
    const headers = upstreamHeaders(incoming(), {
      entrance: 'public',
      clientIp: '203.0.113.7',
      fallbackRequestId: 'ray-123456789',
      gatewaySecret: SECRET,
    });
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('x-csrf-token')).toBeNull();
    expect(headers.get('host')).toBeNull();
    expect(headers.get('x-real-ip')).toBeNull();
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(headers.get('x-mm-signature')).toBe('sig');
    expect(headers.get('x-mm-entrance')).toBe('public');
    // A public caller cannot choose the id that ties log lines together.
    expect(headers.get('x-request-id')).toBe('ray-123456789');
  });

  it('forwards the session headers and the caller-set client IP on the storefront entrance', () => {
    const headers = upstreamHeaders(incoming(), {
      entrance: 'storefront',
      clientIp: '198.51.100.1',
      fallbackRequestId: 'ray-123456789',
      gatewaySecret: SECRET,
    });
    expect(headers.get('cookie')).toBe('__Host-mm_session=abc');
    expect(headers.get('x-csrf-token')).toBe('csrf');
    expect(headers.get('x-forwarded-for')).toBe('198.51.100.1');
    expect(headers.get('x-mm-signature')).toBeNull();
    expect(headers.get('x-mm-entrance')).toBe('storefront');
    expect(headers.get('x-request-id')).toBe('req-from-app-0001');
  });

  it('sends no X-Forwarded-For without a valid client IP', () => {
    const headers = upstreamHeaders(incoming(), {
      entrance: 'admin',
      clientIp: null,
      fallbackRequestId: 'ray-123456789',
      gatewaySecret: SECRET,
    });
    expect(headers.get('x-forwarded-for')).toBeNull();
    expect(headers.get('idempotency-key')).toBeNull();
    expect(headers.get('x-mm-entrance')).toBe('admin');
  });
});

describe('upstreamHeaders: scheduler entrance', () => {
  it('forwards only the signature headers and body type, never a client IP or request id', () => {
    const headers = upstreamHeaders(
      new Headers({
        'content-type': 'application/json',
        accept: 'application/json',
        'x-mm-key-id': 'scheduler',
        'x-mm-timestamp': '1767225600',
        'x-mm-nonce': 'n0nce-abc123-0001',
        'x-mm-signature': 'sig',
        'x-mm-actor': '',
        'x-mm-entrance': 'admin',
        'x-request-id': 'req-from-somewhere-01',
        cookie: 'a=b',
        'user-agent': 'x',
        'x-forwarded-for': '6.6.6.6',
      }),
      {
        entrance: 'scheduler',
        clientIp: '203.0.113.7',
        fallbackRequestId: 'tick-12345678',
        gatewaySecret: SECRET,
      },
    );
    expect(Object.fromEntries(headers.entries())).toEqual({
      'content-type': 'application/json',
      accept: 'application/json',
      'x-mm-key-id': 'scheduler',
      'x-mm-timestamp': '1767225600',
      'x-mm-nonce': 'n0nce-abc123-0001',
      'x-mm-signature': 'sig',
      'x-mm-actor': '',
      'x-mm-entrance': 'scheduler',
      [GATEWAY_SECRET_HEADER]: SECRET,
      'x-request-id': 'tick-12345678',
    });
  });

  it('always overwrites a caller-sent x-mm-entrance', () => {
    for (const entrance of ['public', 'storefront', 'admin'] as const) {
      const headers = upstreamHeaders(new Headers({ 'x-mm-entrance': 'scheduler' }), {
        entrance,
        clientIp: null,
        fallbackRequestId: 'ray-123456789',
        gatewaySecret: SECRET,
      });
      expect(headers.get('x-mm-entrance')).toBe(entrance);
    }
  });
});

describe('gateway secret header', () => {
  it.each(['public', 'storefront', 'admin', 'scheduler'] as const)(
    'replaces a spoofed secret with the configured one on the %s entrance',
    (entrance) => {
      const headers = upstreamHeaders(
        new Headers({
          [GATEWAY_SECRET_HEADER]: 'spoofed-by-the-caller',
          'X-MM-Gateway-Secret': 'x',
        }),
        { entrance, clientIp: null, fallbackRequestId: 'ray-123456789', gatewaySecret: SECRET },
      );
      expect(headers.get(GATEWAY_SECRET_HEADER)).toBe(SECRET);
    },
  );
});

describe('functionOrigin and upstreamUrl', () => {
  it('accepts the invocation URL (origin, optional trailing slash)', () => {
    const url = 'https://br-x-coreapi.compute.c-7.eu-central-1.aws.neon.tech/';
    expect(functionOrigin(url)).toBe('https://br-x-coreapi.compute.c-7.eu-central-1.aws.neon.tech');
    expect(functionOrigin(` ${url.slice(0, -1)} `)).toBe(
      'https://br-x-coreapi.compute.c-7.eu-central-1.aws.neon.tech',
    );
  });

  it.each([
    undefined,
    '',
    'not a url',
    'http://plain.example',
    'https://user:pass@x.example',
    'https://x.example/base',
    'https://x.example/?q=1',
  ])('refuses %s', (value) => {
    expect(functionOrigin(value)).toBeNull();
  });

  it('keeps the authority fixed whatever the request path is', () => {
    const origin = 'https://fn.example';
    expect(upstreamUrl(origin, new URL('https://gw.example/api/v1/orders?x=1')).href).toBe(
      'https://fn.example/api/v1/orders?x=1',
    );
    expect(upstreamUrl(origin, new URL('https://gw.example//evil.example/api/v1')).host).toBe(
      'fn.example',
    );
  });
});

describe('errorResponse', () => {
  it('uses the Core API envelope and no-store', async () => {
    const response = errorResponse(404, 'not_found', 'Not Found');
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: { code: 'not_found', message: 'Not Found' } });
  });
});
