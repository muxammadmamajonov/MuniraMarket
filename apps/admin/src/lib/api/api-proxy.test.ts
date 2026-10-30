import { describe, expect, it, vi } from 'vitest';
import { MAX_BODY_BYTES, createApiProxy } from './api-proxy';

const ORDER_ID = '0b1f4c7e-2d4a-4f3b-9a53-6f0f1b8a7c11';

function setup(upstream: () => Response | Promise<Response> = () => Response.json({ ok: true })) {
  const fetchMock = vi.fn<typeof fetch>(async () => upstream());
  const handle = createApiProxy({ fetch: fetchMock, apiBaseUrl: () => 'http://api.test:8000' });
  const call = (path: string[], url: string, init?: RequestInit) =>
    handle(new Request(url, init), { params: Promise.resolve({ path }) });
  return { fetchMock, call };
}

function lastCall(fetchMock: ReturnType<typeof setup>['fetchMock']) {
  const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
  return { url: String(url), init: init as RequestInit, headers: new Headers(init?.headers) };
}

describe('admin api proxy: allowlist', () => {
  it.each([
    [['auth', 'config']],
    [['auth', 'session']],
    [['auth', 'logout']],
    [['auth', 'telegram', 'login-widget']],
    [['admin', 'orders']],
    [['admin', 'orders', ORDER_ID]],
    [['admin', 'orders', ORDER_ID, 'status']],
  ])('forwards the Login Widget auth routes and admin/**: %j', async (path) => {
    const { fetchMock, call } = setup();
    const response = await call(path, `http://admin.test/api/v1/${path.join('/')}`);
    expect(response.status).toBe(200);
    expect(lastCall(fetchMock).url).toBe(`http://api.test:8000/api/v1/${path.join('/')}`);
  });

  it.each([
    [['internal', 'orders']],
    [['Internal', 'orders']],
    [['INTERNAL']],
    [['internal', 'a', 'b']],
    [['products']],
    [['categories']],
    [['cart']],
    [['cart', 'items']],
    [['orders']],
    [['orders', ORDER_ID, 'cancel']],
    [['checkout', 'quote']],
    [['delivery', 'zones']],
    [['health']],
    [['health', 'ready']],
    [['Admin', 'orders']],
    [['AUTH', 'session']],
    [['administrator']],
    [['authx', 'session']],
    [[' admin', 'orders']],
    [['admin%2Forders']],
    // The Mini App sign-in must never mint a back-office session (replayable initData).
    [['auth', 'telegram', 'init-data']],
    [['auth', 'telegram']],
    [['auth']],
    [['auth', 'session', 'extra']],
    [['auth', 'Session']],
  ])('answers everything else with a 404 envelope and never calls the API: %j', async (path) => {
    const { fetchMock, call } = setup();
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      const response = await call(path, `http://admin.test/api/v1/${path.join('/')}`, {
        method,
        ...(method === 'GET' ? {} : { body: '{}' }),
      });
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toMatch(/json/);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect((await response.json()).error.code).toBe('not_found');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 404 when there is no path at all', async () => {
    const { fetchMock, call } = setup();
    const response = await call([], 'http://admin.test/api/v1/');
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [['..', 'internal', 'x']],
    [['admin', '..', 'internal', 'x']],
    [['auth', '..', 'internal']],
    [['admin', '.', 'orders']],
    [['admin', 'a/b']],
    [['admin', 'a\\b']],
    [['admin', 'a\0b']],
    [['admin', '', 'orders']],
    [['']],
  ])('refuses traversal-looking segments even under an allowed area: %j', async (path) => {
    const { fetchMock, call } = setup();
    const response = await call(path, 'http://admin.test/api/v1/x');
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('admin api proxy: forwarding', () => {
  it('forwards method, path and query to API_INTERNAL_URL', async () => {
    const { fetchMock, call } = setup();
    await call(
      ['admin', 'orders'],
      'http://admin.test/api/v1/admin/orders?status=NEW&page=2&page_size=20',
    );
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe('http://api.test:8000/api/v1/admin/orders?status=NEW&page=2&page_size=20');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('never follows redirects and never uses a cache', async () => {
    const { fetchMock, call } = setup();
    await call(['admin', 'orders'], 'http://admin.test/api/v1/admin/orders');
    const { init } = lastCall(fetchMock);
    expect(init.redirect).toBe('manual');
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('forwards only the allow-listed request headers (cookie and x-csrf-token included)', async () => {
    const { fetchMock, call } = setup();
    await call(['admin', 'orders', ORDER_ID, 'status'], 'http://admin.test/x', {
      method: 'PATCH',
      body: '{}',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'accept-language': 'uz',
        cookie: '__Host-mm_session=abc',
        'x-csrf-token': 'csrf',
        origin: 'http://admin.test',
        'user-agent': 'UA',
        'x-forwarded-for': '203.0.113.7',
        authorization: 'Bearer secret',
        'x-service-signature': 'nope',
        host: 'evil.test',
      },
    });
    const { headers } = lastCall(fetchMock);
    expect(Object.fromEntries(headers.entries())).toEqual({
      'content-type': 'application/json',
      accept: 'application/json',
      'accept-language': 'uz',
      cookie: '__Host-mm_session=abc',
      'x-csrf-token': 'csrf',
      origin: 'http://admin.test',
      'user-agent': 'UA',
    });
  });

  it('never forwards a browser-supplied x-forwarded-for', async () => {
    const { fetchMock, call } = setup();
    await call(['admin', 'orders'], 'http://admin.test/api/v1/admin/orders', {
      headers: { 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '203.0.113.8' },
    });
    expect(lastCall(fetchMock).headers.has('x-forwarded-for')).toBe(false);
  });

  it('forwards the client IP only from the configured edge header, if it is a valid IP', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    const handle = createApiProxy({
      fetch: fetchMock,
      apiBaseUrl: () => 'http://api.test:8000',
      clientIpHeader: () => 'x-real-ip',
    });
    const send = (headers: Record<string, string>) =>
      handle(new Request('http://admin.test/api/v1/admin/orders', { headers }), {
        params: Promise.resolve({ path: ['admin', 'orders'] }),
      });

    await send({ 'x-real-ip': '198.51.100.4', 'x-forwarded-for': '203.0.113.7' });
    expect(lastCall(fetchMock).headers.get('x-forwarded-for')).toBe('198.51.100.4');

    for (const bad of ['198.51.100.4, 10.0.0.1', 'not-an-ip', '']) {
      await send({ 'x-real-ip': bad });
      expect(lastCall(fetchMock).headers.has('x-forwarded-for')).toBe(false);
    }
  });

  it('forwards a JSON body unchanged', async () => {
    const { fetchMock, call } = setup();
    const payload = JSON.stringify({ status: 'CONFIRMED', expected_status: 'NEW' });
    await call(['admin', 'orders', ORDER_ID, 'status'], 'http://admin.test/x', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    const { init } = lastCall(fetchMock);
    expect(init.method).toBe('PATCH');
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(payload);
  });

  it('sends no body for an empty POST (logout)', async () => {
    const { fetchMock, call } = setup(() => new Response(null, { status: 204 }));
    const response = await call(['auth', 'logout'], 'http://admin.test/api/v1/auth/logout', {
      method: 'POST',
    });
    expect(lastCall(fetchMock).init.body).toBeUndefined();
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it('percent-encodes path segments it forwards', async () => {
    const { fetchMock, call } = setup();
    await call(['admin', 'orders', 'a b?x#y'], 'http://admin.test/api/v1/admin/orders/a%20b');
    expect(lastCall(fetchMock).url).toBe('http://api.test:8000/api/v1/admin/orders/a%20b%3Fx%23y');
  });

  it('returns status, body and selected headers, including several Set-Cookie values', async () => {
    const upstream = new Response(JSON.stringify({ user: {} }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'retry-after': '3',
        'cache-control': 'no-store',
        'x-internal-secret': 'leak',
        server: 'uvicorn',
      },
    });
    upstream.headers.append('set-cookie', '__Host-mm_session=new; Path=/; HttpOnly; Secure');
    upstream.headers.append('set-cookie', 'other=1; Path=/');
    const { call } = setup(() => upstream);

    const response = await call(['auth', 'session'], 'http://admin.test/api/v1/auth/session');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: {} });
    expect(response.headers.get('retry-after')).toBe('3');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-internal-secret')).toBeNull();
    expect(response.headers.get('server')).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([
      '__Host-mm_session=new; Path=/; HttpOnly; Secure',
      'other=1; Path=/',
    ]);
  });

  it('passes upstream error responses (403, 409) through untouched', async () => {
    const { call } = setup(() =>
      Response.json(
        { error: { code: 'order_status_conflict', message: 'x', current_status: 'CONFIRMED' } },
        { status: 409 },
      ),
    );
    const response = await call(['admin', 'orders', ORDER_ID, 'status'], 'http://admin.test/x', {
      method: 'PATCH',
      body: '{}',
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.current_status).toBe('CONFIRMED');
  });

  it('defaults to no-store when the API sent no cache header, and for any cookie response', async () => {
    const { call: bare } = setup(() => new Response('{}'));
    const plain = await bare(['admin', 'orders'], 'http://admin.test/api/v1/admin/orders');
    expect(plain.headers.get('cache-control')).toBe('no-store');

    const upstream = new Response('{}', { headers: { 'cache-control': 'public, max-age=60' } });
    upstream.headers.append('set-cookie', 'a=b');
    const { call } = setup(() => upstream);
    const withCookie = await call(['auth', 'session'], 'http://admin.test/api/v1/auth/session');
    expect(withCookie.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 502 service_unavailable when the API is unreachable', async () => {
    const { call } = setup(() => {
      throw new TypeError('fetch failed');
    });
    const response = await call(['admin', 'orders'], 'http://admin.test/api/v1/admin/orders');
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe('service_unavailable');
  });

  it('answers 504 service_unavailable on timeout', async () => {
    const { call } = setup(() => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    const response = await call(['admin', 'orders'], 'http://admin.test/api/v1/admin/orders');
    expect(response.status).toBe(504);
  });

  it('treats an upstream redirect as a bad gateway and never forwards Location', async () => {
    const { call } = setup(
      () => new Response(null, { status: 307, headers: { location: 'http://api.internal/x/' } }),
    );
    const response = await call(['admin', 'orders'], 'http://admin.test/api/v1/admin/orders');
    expect(response.status).toBe(502);
    expect(response.headers.get('location')).toBeNull();
  });

  it('rejects bodies over 64 KiB, by Content-Length or by streaming, without calling the API', async () => {
    const { fetchMock, call } = setup();
    const declared = await call(['auth', 'telegram', 'login-widget'], 'http://admin.test/x', {
      method: 'POST',
      headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
      body: 'x',
    });
    expect(declared.status).toBe(413);

    const big = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_BODY_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const streamed = await call(['auth', 'telegram', 'login-widget'], 'http://admin.test/x', {
      method: 'POST',
      body: big,
      duplex: 'half',
    } as RequestInit);
    expect(streamed.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
