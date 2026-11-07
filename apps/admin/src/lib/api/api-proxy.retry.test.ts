import { describe, expect, it, vi } from 'vitest';
import { createApiProxy, isRetryable, type ProxyDeps } from './api-proxy';

/**
 * Request ids, failed OIDC callbacks and the single retry of the admin API proxy. The allowlist,
 * header and body handling are covered in `api-proxy.test.ts`.
 */

const ORDER_ID = '0b1f4c7e-2d4a-4f3b-9a53-6f0f1b8a7c11';
const REQUEST_ID = '0123456789abcdef0123456789abcdef';
const CALLBACK_URL = 'http://admin.test/api/v1/auth/telegram/oidc/callback?code=abc&state=xyz';
const CALLBACK = ['auth', 'telegram', 'oidc', 'callback'];

function setup(upstream: () => Response | Promise<Response>, overrides: Partial<ProxyDeps> = {}) {
  const fetchMock = vi.fn<typeof fetch>(async () => upstream());
  const handle = createApiProxy({
    fetch: fetchMock,
    apiBaseUrl: () => 'http://api.test:8000',
    sleep: async () => {},
    requestId: () => REQUEST_ID,
    ...overrides,
  });
  const call = (path: string[], url: string, init?: RequestInit) =>
    handle(new Request(url, init), { params: Promise.resolve({ path }) });
  return { fetchMock, call };
}

function sequence(...responses: (Response | Error | DOMException)[]) {
  let index = 0;
  return () => {
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    // jsdom's DOMException is not an `Error`, so test for the Response instead.
    if (!(next instanceof Response)) throw next;
    return next;
  };
}

const unavailable = () =>
  Response.json({ error: { code: 'service_unavailable', message: 'x' } }, { status: 503 });

describe('admin api proxy: request id', () => {
  it('sends its own X-Request-ID upstream, never the browser one', async () => {
    const { fetchMock, call } = setup(() => Response.json({}));
    await call(['admin', 'orders'], 'http://admin.test/api/v1/admin/orders', {
      headers: { 'x-request-id': 'browser-chosen-id-123' },
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get('x-request-id')).toBe(REQUEST_ID);
  });

  it("returns the upstream's request id, or its own, on every response", async () => {
    const withUpstreamId = setup(() =>
      Response.json({}, { headers: { 'x-request-id': 'fedcba9876543210' } }),
    );
    const a = await withUpstreamId.call(
      ['auth', 'session'],
      'http://admin.test/api/v1/auth/session',
    );
    expect(a.headers.get('x-request-id')).toBe('fedcba9876543210');

    const without = setup(() => Response.json({}));
    const b = await without.call(['auth', 'session'], 'http://admin.test/api/v1/auth/session');
    expect(b.headers.get('x-request-id')).toBe(REQUEST_ID);

    const malformed = setup(() => Response.json({}, { headers: { 'x-request-id': 'a b' } }));
    const c = await malformed.call(['auth', 'session'], 'http://admin.test/api/v1/auth/session');
    expect(c.headers.get('x-request-id')).toBe(REQUEST_ID);
  });

  it('puts the request id on its own error envelopes', async () => {
    const { call } = setup(() => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    const response = await call(['admin', 'orders'], 'http://admin.test/api/v1/admin/orders');
    expect(response.status).toBe(504);
    expect(response.headers.get('x-request-id')).toBe(REQUEST_ID);
    expect((await response.json()).error.code).toBe('service_unavailable');
  });

  it('logs failures with the request id and route, never the query string', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { call } = setup(() => {
        throw new DOMException('timed out', 'TimeoutError');
      });
      await call(
        CALLBACK,
        'http://admin.test/api/v1/auth/telegram/oidc/callback?code=SECRET-CODE&state=s',
      );
      const line = String(spy.mock.calls[0]?.[0]);
      expect(JSON.parse(line)).toMatchObject({
        request_id: REQUEST_ID,
        route: 'auth/telegram/oidc/callback',
        reason: 'timeout',
      });
      expect(line).not.toContain('SECRET-CODE');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('admin api proxy: failed OIDC callback', () => {
  it.each([
    [429, 'unavailable'],
    [500, 'unavailable'],
    [502, 'unavailable'],
    [503, 'unavailable'],
    [504, 'unavailable'],
    [400, 'failed'],
    [422, 'failed'],
  ])('turns a JSON %i into a redirect to the sign-in page (%s)', async (status, expected) => {
    const { fetchMock, call } = setup(() =>
      Response.json({ error: { code: 'service_unavailable', message: 'x' } }, { status }),
    );
    const response = await call(CALLBACK, CALLBACK_URL);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `/uz/auth/telegram?status=${expected}&ref=01234567`,
    );
    expect(response.headers.get('content-type')).toBeNull();
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    // Never retried: the callback consumes the one-time state.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['timeout', new DOMException('timed out', 'TimeoutError')],
    ['network failure', new TypeError('fetch failed')],
  ])('redirects on a %s, once, in the visitor locale', async (_label, error) => {
    const { fetchMock, call } = setup(() => {
      throw error;
    });
    const response = await call(CALLBACK, CALLBACK_URL, {
      headers: { cookie: 'other=1; locale=ru', 'accept-language': 'uz' },
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      '/ru/auth/telegram?status=unavailable&ref=01234567',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to Accept-Language, then uz', async () => {
    const fail = () => Response.json({}, { status: 503 });
    const ru = await setup(fail).call(CALLBACK, CALLBACK_URL, {
      headers: { 'accept-language': 'ru-RU,ru;q=0.9' },
    });
    expect(ru.headers.get('location')).toMatch(/^\/ru\/auth\/telegram\?/);
    const fallback = await setup(fail).call(CALLBACK, CALLBACK_URL);
    expect(fallback.headers.get('location')).toMatch(/^\/uz\/auth\/telegram\?/);
  });
});

describe('admin api proxy: retry', () => {
  it.each([
    ['a 503', unavailable()],
    ['a 502', Response.json({}, { status: 502 })],
    ['a network failure', new TypeError('fetch failed')],
  ])('retries a GET once after %s and returns the second answer', async (_label, first) => {
    const { fetchMock, call } = setup(sequence(first, Response.json({ items: [] })));
    const response = await call(['admin', 'orders'], 'http://admin.test/api/v1/admin/orders');
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries the OIDC start once, with the same body', async () => {
    const { fetchMock, call } = setup(
      sequence(unavailable(), Response.json({ authorization_url: 'https://oauth.telegram.org/x' })),
    );
    const response = await call(
      ['auth', 'telegram', 'oidc', 'start'],
      'http://admin.test/api/v1/auth/telegram/oidc/start',
      {
        method: 'POST',
        body: '{"return_to":"/uz"}',
        headers: { 'content-type': 'application/json' },
      },
    );
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe('{"return_to":"/uz"}');
    }
  });

  it('gives up after the second failure', async () => {
    const { fetchMock, call } = setup(unavailable);
    const response = await call(['admin', 'orders'], 'http://admin.test/api/v1/admin/orders');
    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['POST', ['admin', 'orders', ORDER_ID, 'status']],
    ['PATCH', ['admin', 'catalog', 'products', ORDER_ID]],
    ['DELETE', ['admin', 'delivery', 'zones', ORDER_ID]],
    ['POST', ['admin', 'catalog', 'csv', 'import']],
    ['POST', ['auth', 'logout']],
    ['GET', CALLBACK],
  ])('never retries %s %j', async (method, path) => {
    const { fetchMock, call } = setup(sequence(unavailable(), Response.json({})));
    await call(path, `http://admin.test/api/v1/${path.join('/')}`, {
      method,
      ...(method === 'GET' ? {} : { body: '{}' }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a timeout', new DOMException('timed out', 'TimeoutError')],
    ['a 504', Response.json({}, { status: 504 })],
    ['a 500', Response.json({}, { status: 500 })],
    ['a 429', Response.json({}, { status: 429 })],
  ])('never retries after %s', async (_label, first) => {
    const { fetchMock, call } = setup(sequence(first, Response.json({})));
    await call(['admin', 'orders'], 'http://admin.test/api/v1/admin/orders');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the remaining budget is too small', async () => {
    let clock = 0;
    const { fetchMock, call } = setup(sequence(unavailable(), Response.json({})), {
      // Every clock read advances 11 s: the first attempt "took" most of the 25 s budget.
      now: () => {
        const value = clock;
        clock += 11_000;
        return value;
      },
    });
    const response = await call(['admin', 'orders'], 'http://admin.test/api/v1/admin/orders');
    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('isRetryable: reads and the OIDC start only', () => {
    expect(isRetryable('GET', 'admin/orders')).toBe(true);
    expect(isRetryable('GET', 'auth/session')).toBe(true);
    expect(isRetryable('POST', 'auth/telegram/oidc/start')).toBe(true);
    expect(isRetryable('GET', 'auth/telegram/oidc/callback')).toBe(false);
    expect(isRetryable('POST', 'admin/orders')).toBe(false);
    expect(isRetryable('POST', 'admin/catalog/csv/import')).toBe(false);
    expect(isRetryable('PUT', 'admin/orders')).toBe(false);
  });
});
