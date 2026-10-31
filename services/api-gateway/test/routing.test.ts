import { describe, expect, it } from 'vitest';
import {
  apiSegments,
  errorResponse,
  instanceName,
  isAllowed,
  singleIp,
  upstreamHeaders,
} from '../src/routing';

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

  it('exposes only signed Telegram routes publicly', () => {
    expect(isAllowed('public', 'POST', '/api/v1/internal/telegram/notifications/claim')).toBe(true);
    expect(isAllowed('public', 'GET', '/api/v1/internal/telegram/notifications/claim')).toBe(false);
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

  it('gives the admin only back-office and Login Widget routes', () => {
    expect(isAllowed('admin', 'GET', '/api/v1/admin/orders')).toBe(true);
    expect(isAllowed('admin', 'POST', '/api/v1/auth/telegram/login-widget')).toBe(true);
    expect(isAllowed('admin', 'GET', '/api/v1/auth/session')).toBe(true);
    expect(isAllowed('admin', 'POST', '/api/v1/auth/telegram/init-data')).toBe(false);
    expect(isAllowed('admin', 'GET', '/api/v1/cart')).toBe(false);
    expect(isAllowed('admin', 'POST', '/api/v1/internal/telegram/notifications/claim')).toBe(false);
    expect(isAllowed('admin', 'GET', '/api/v1/Admin/orders')).toBe(false);
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
    });
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('x-csrf-token')).toBeNull();
    expect(headers.get('host')).toBeNull();
    expect(headers.get('x-real-ip')).toBeNull();
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(headers.get('x-mm-signature')).toBe('sig');
    // A public caller cannot choose the id that ties log lines together.
    expect(headers.get('x-request-id')).toBe('ray-123456789');
  });

  it('forwards the session headers and the caller-set client IP on the storefront entrance', () => {
    const headers = upstreamHeaders(incoming(), {
      entrance: 'storefront',
      clientIp: '198.51.100.1',
      fallbackRequestId: 'ray-123456789',
    });
    expect(headers.get('cookie')).toBe('__Host-mm_session=abc');
    expect(headers.get('x-csrf-token')).toBe('csrf');
    expect(headers.get('x-forwarded-for')).toBe('198.51.100.1');
    expect(headers.get('x-mm-signature')).toBeNull();
    expect(headers.get('x-request-id')).toBe('req-from-app-0001');
  });

  it('sends no X-Forwarded-For without a valid client IP', () => {
    const headers = upstreamHeaders(incoming(), {
      entrance: 'admin',
      clientIp: null,
      fallbackRequestId: 'ray-123456789',
    });
    expect(headers.get('x-forwarded-for')).toBeNull();
    expect(headers.get('idempotency-key')).toBeNull();
  });
});

describe('errorResponse and instanceName', () => {
  it('uses the Core API envelope and no-store', async () => {
    const response = errorResponse(404, 'not_found', 'Not Found');
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: { code: 'not_found', message: 'Not Found' } });
  });

  it('spreads requests over a bounded pool', () => {
    expect(instanceName(3, () => 0)).toBe('core-api-0');
    expect(instanceName(3, () => 0.999)).toBe('core-api-2');
    expect(instanceName(Number.NaN, () => 0.5)).toBe('core-api-0');
    expect(instanceName(0, () => 0.5)).toBe('core-api-0');
  });
});
