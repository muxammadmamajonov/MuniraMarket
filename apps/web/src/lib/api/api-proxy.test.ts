import { describe, expect, it, vi } from 'vitest';
import { MAX_BODY_BYTES, createApiProxy } from './api-proxy';

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

describe('api proxy', () => {
  it('forwards method, path and query to API_INTERNAL_URL', async () => {
    const { fetchMock, call } = setup();
    const response = await call(
      ['products'],
      'http://web.test/api/v1/products?category=demo-fruit&q=ol%20ma&page=2',
    );
    expect(response.status).toBe(200);
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe('http://api.test:8000/api/v1/products?category=demo-fruit&q=ol%20ma&page=2');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('never follows redirects and never uses a cache', async () => {
    const { fetchMock, call } = setup();
    await call(['categories'], 'http://web.test/api/v1/categories');
    const { init } = lastCall(fetchMock);
    expect(init.redirect).toBe('manual');
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('forwards only the allow-listed request headers', async () => {
    const { fetchMock, call } = setup();
    await call(['cart'], 'http://web.test/api/v1/cart', {
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'accept-language': 'uz',
        cookie: '__Host-mm_session=abc',
        'x-csrf-token': 'csrf',
        origin: 'http://web.test',
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
      origin: 'http://web.test',
      'user-agent': 'UA',
    });
  });

  it('never forwards a browser-supplied x-forwarded-for', async () => {
    const { fetchMock, call } = setup();
    await call(['cart'], 'http://web.test/api/v1/cart', {
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
      handle(new Request('http://web.test/api/v1/cart', { headers }), {
        params: Promise.resolve({ path: ['cart'] }),
      });

    await send({ 'x-real-ip': '198.51.100.4', 'x-forwarded-for': '203.0.113.7' });
    expect(lastCall(fetchMock).headers.get('x-forwarded-for')).toBe('198.51.100.4');

    await send({ 'x-real-ip': '2001:db8::1' });
    expect(lastCall(fetchMock).headers.get('x-forwarded-for')).toBe('2001:db8::1');

    for (const bad of ['198.51.100.4, 10.0.0.1', 'not-an-ip', '']) {
      await send({ 'x-real-ip': bad });
      expect(lastCall(fetchMock).headers.has('x-forwarded-for')).toBe(false);
    }
  });

  it('forwards a JSON body unchanged', async () => {
    const { fetchMock, call } = setup();
    const payload = JSON.stringify({ product_id: 'p1', quantity: 2 });
    await call(['cart', 'items'], 'http://web.test/api/v1/cart/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    const { init } = lastCall(fetchMock);
    expect(init.method).toBe('POST');
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(payload);
  });

  it('sends no body for an empty POST/DELETE', async () => {
    const { fetchMock, call } = setup();
    await call(['cart', 'items', 'p1'], 'http://web.test/api/v1/cart/items/p1', {
      method: 'DELETE',
    });
    expect(lastCall(fetchMock).init.body).toBeUndefined();
  });

  it('percent-encodes path segments it forwards', async () => {
    const { fetchMock, call } = setup();
    await call(['products', 'a b?x#y'], 'http://web.test/api/v1/products/a%20b%3Fx%23y');
    expect(lastCall(fetchMock).url).toBe('http://api.test:8000/api/v1/products/a%20b%3Fx%23y');
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

    const response = await call(['auth', 'session'], 'http://web.test/api/v1/auth/session');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: {} });
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('retry-after')).toBe('3');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-internal-secret')).toBeNull();
    expect(response.headers.get('server')).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([
      '__Host-mm_session=new; Path=/; HttpOnly; Secure',
      'other=1; Path=/',
    ]);
  });

  it('passes upstream error responses through untouched', async () => {
    const { call } = setup(() =>
      Response.json(
        { error: { code: 'insufficient_stock', message: 'x', available_quantity: 2 } },
        { status: 409 },
      ),
    );
    const response = await call(['cart', 'items'], 'http://web.test/api/v1/cart/items', {
      method: 'POST',
      body: '{}',
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.available_quantity).toBe(2);
  });

  it('keeps upstream public cache headers for catalog responses and defaults the rest to no-store', async () => {
    const { call: cacheable } = setup(
      () => new Response('{}', { headers: { 'cache-control': 'public, max-age=60' } }),
    );
    const catalog = await cacheable(['categories'], 'http://web.test/api/v1/categories');
    expect(catalog.headers.get('cache-control')).toBe('public, max-age=60');

    const { call: bare } = setup(() => new Response('{}'));
    const other = await bare(['categories'], 'http://web.test/api/v1/categories');
    expect(other.headers.get('cache-control')).toBe('no-store');
  });

  it('never lets a response that sets a cookie be cached', async () => {
    const upstream = new Response('{}', { headers: { 'cache-control': 'public, max-age=60' } });
    upstream.headers.append('set-cookie', 'a=b');
    const { call } = setup(() => upstream);
    const response = await call(['auth', 'session'], 'http://web.test/api/v1/auth/session');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('returns a body-less response for 204', async () => {
    const { call } = setup(() => new Response(null, { status: 204 }));
    const response = await call(['auth', 'logout'], 'http://web.test/api/v1/auth/logout', {
      method: 'POST',
    });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it.each([
    [['internal', 'orders']],
    [['Internal', 'orders']],
    [['INTERNAL']],
    [['internal', 'a', 'b']],
  ])('refuses internal routes with a 404 envelope: %j', async (path) => {
    const { fetchMock, call } = setup();
    const response = await call(path, `http://web.test/api/v1/${path.join('/')}`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toMatch(/json/);
    expect((await response.json()).error.code).toBe('not_found');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [['admin', 'orders']],
    [['Admin', 'orders']],
    [['ADMIN']],
    [['admin', 'orders', '1c9f0000-0000-4000-8000-000000000000', 'status']],
  ])('refuses back-office routes with a 404 envelope: %j', async (path) => {
    const { fetchMock, call } = setup();
    const response = await call(path, `http://web.test/api/v1/${path.join('/')}`, {
      method: 'PATCH',
      body: '{}',
    });
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('not_found');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still forwards routes that merely contain "admin" or "internal" deeper in the path', async () => {
    const { fetchMock, call } = setup();
    await call(['orders', 'admin'], 'http://web.test/api/v1/orders/admin');
    await call(['products', 'internal'], 'http://web.test/api/v1/products/internal');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('forwards the Idempotency-Key request header unchanged', async () => {
    const { fetchMock, call } = setup();
    await call(['orders'], 'http://web.test/api/v1/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'test-idempotency-key-0001' },
      body: '{}',
    });
    expect(lastCall(fetchMock).headers.get('idempotency-key')).toBe('test-idempotency-key-0001');
  });

  it('returns the Idempotent-Replayed response header (and status 200) to the browser', async () => {
    const { call } = setup(
      () =>
        new Response(JSON.stringify({ id: 'o1' }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'idempotent-replayed': 'true' },
        }),
    );
    const response = await call(['orders'], 'http://web.test/api/v1/orders', {
      method: 'POST',
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Idempotent-Replayed')).toBe('true');
  });

  it('does not invent an Idempotent-Replayed header on a first request', async () => {
    const { call } = setup(() => Response.json({ id: 'o1' }, { status: 201 }));
    const response = await call(['orders'], 'http://web.test/api/v1/orders', {
      method: 'POST',
      body: '{}',
    });
    expect(response.status).toBe(201);
    expect(response.headers.has('idempotent-replayed')).toBe(false);
  });

  it.each([[['..', 'internal', 'x']], [['auth', '..', 'internal']], [['a/b']], [['a\\b']], [['']]])(
    'refuses traversal-looking segments: %j',
    async (path) => {
      const { fetchMock, call } = setup();
      const response = await call(path, 'http://web.test/api/v1/x');
      expect(response.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('answers 502 service_unavailable when the API is unreachable', async () => {
    const { call } = setup(() => {
      throw new TypeError('fetch failed');
    });
    const response = await call(['categories'], 'http://web.test/api/v1/categories');
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: 'service_unavailable', message: expect.any(String) },
    });
  });

  it('answers 504 service_unavailable on timeout', async () => {
    const { call } = setup(() => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    const response = await call(['categories'], 'http://web.test/api/v1/categories');
    expect(response.status).toBe(504);
    expect((await response.json()).error.code).toBe('service_unavailable');
  });

  it('treats an upstream redirect as a bad gateway and never forwards Location', async () => {
    const { call } = setup(
      () => new Response(null, { status: 307, headers: { location: 'http://api.internal/x/' } }),
    );
    const response = await call(['categories'], 'http://web.test/api/v1/categories');
    expect(response.status).toBe(502);
    expect(response.headers.get('location')).toBeNull();
  });

  it('rejects bodies over 64 KiB by Content-Length without calling the API', async () => {
    const { fetchMock, call } = setup();
    const response = await call(['cart', 'items'], 'http://web.test/api/v1/cart/items', {
      method: 'POST',
      headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
      body: 'x',
    });
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe('payload_too_large');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects oversized bodies even without a Content-Length', async () => {
    const { fetchMock, call } = setup();
    const big = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_BODY_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const response = await call(['cart', 'items'], 'http://web.test/api/v1/cart/items', {
      method: 'POST',
      body: big,
      duplex: 'half',
    } as RequestInit);
    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a body of exactly 64 KiB', async () => {
    const { fetchMock, call } = setup();
    const response = await call(['cart', 'items'], 'http://web.test/api/v1/cart/items', {
      method: 'POST',
      body: new Uint8Array(MAX_BODY_BYTES),
    });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
