import { describe, expect, it } from 'vitest';
import { forward, type ForwardDeps } from '../src/forward';
import { GATEWAY_SECRET_HEADER } from '../src/routing';

// Test-only values; not real credentials.
const ORIGIN = 'https://br-test-coreapi.compute.c-1.eu-central-1.aws.neon.tech/';
const SECRET = 'test-only-function-secret-0123456789abcdef';

function deps(
  handler: (request: Request) => Response | Promise<Response>,
  overrides: Partial<ForwardDeps> = {},
): ForwardDeps & { seen: Request[] } {
  const seen: Request[] = [];
  return {
    env: { CORE_API_FUNCTION_ORIGIN: ORIGIN, CORE_API_FUNCTION_SECRET: SECRET },
    fetch: async (request) => {
      seen.push(request);
      return handler(request);
    },
    seen,
    ...overrides,
  };
}

describe('forward: gateway -> Function', () => {
  it('forwards an allowed storefront request to the Function with the secret', async () => {
    const d = deps(() => Response.json({ items: [] }));
    const response = await forward(
      new Request('https://web.example/api/v1/products?q=olma', {
        headers: { cookie: 'mm_session=x', 'x-forwarded-for': '198.51.100.4' },
      }),
      d,
      'storefront',
    );
    expect(response.status).toBe(200);
    const [upstream] = d.seen as [Request];
    expect(upstream.url).toBe(
      'https://br-test-coreapi.compute.c-1.eu-central-1.aws.neon.tech/api/v1/products?q=olma',
    );
    expect(upstream.headers.get(GATEWAY_SECRET_HEADER)).toBe(SECRET);
    expect(upstream.headers.get('x-mm-entrance')).toBe('storefront');
    expect(upstream.headers.get('x-forwarded-for')).toBe('198.51.100.4');
    expect(upstream.redirect).toBe('manual');
  });

  it('drops a spoofed gateway secret / entrance sent by the caller', async () => {
    const d = deps(() => new Response(null, { status: 204 }));
    await forward(
      new Request('https://api.example/api/v1/internal/telegram/session', {
        method: 'POST',
        headers: {
          [GATEWAY_SECRET_HEADER]: 'attacker-chosen-value-attacker-chosen-value',
          'x-mm-entrance': 'admin',
          'cf-connecting-ip': '203.0.113.9',
        },
        body: '{}',
      }),
      d,
      'public',
    );
    const [upstream] = d.seen as [Request];
    expect(upstream.headers.get(GATEWAY_SECRET_HEADER)).toBe(SECRET);
    expect(upstream.headers.get('x-mm-entrance')).toBe('public');
    expect(upstream.headers.get('x-forwarded-for')).toBe('203.0.113.9');
  });

  it('never calls the Function for a refused path', async () => {
    const d = deps(() => Response.json({}));
    const response = await forward(
      new Request('https://api.example/api/v1/admin/orders'),
      d,
      'public',
    );
    expect(response.status).toBe(404);
    expect(d.seen).toHaveLength(0);
  });

  it('passes the Function 401 (bad gateway secret) through unchanged', async () => {
    const d = deps(() =>
      Response.json({ error: { code: 'unauthorized', message: 'Unauthorized' } }, { status: 401 }),
    );
    const response = await forward(new Request('https://x/api/v1/health'), d, 'public');
    expect(response.status).toBe(401);
  });

  it('answers 504 when the Function does not answer in time', async () => {
    const d = deps(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason));
        }),
      { timeouts: { upstreamMs: 20, schedulerMs: 20 } },
    );
    const response = await forward(new Request('https://x/api/v1/health'), d, 'public');
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: { code: 'service_unavailable', message: 'The service took too long to respond' },
    });
  });

  it('answers 502 on a network failure and refuses redirects', async () => {
    const failing = deps(() => {
      throw new TypeError('network');
    });
    expect((await forward(new Request('https://x/api/v1/health'), failing, 'public')).status).toBe(
      502,
    );
    const redirecting = deps(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }),
    );
    const response = await forward(new Request('https://x/api/v1/health'), redirecting, 'public');
    expect(response.status).toBe(502);
    expect(response.headers.get('location')).toBeNull();
  });

  it.each([
    [{ CORE_API_FUNCTION_SECRET: SECRET }],
    [{ CORE_API_FUNCTION_ORIGIN: ORIGIN }],
    [{ CORE_API_FUNCTION_ORIGIN: ORIGIN, CORE_API_FUNCTION_SECRET: 'too-short' }],
    [{ CORE_API_FUNCTION_ORIGIN: 'http://insecure.example', CORE_API_FUNCTION_SECRET: SECRET }],
  ])('fails closed with 503 when misconfigured (%j)', async (env) => {
    const d = deps(() => Response.json({}), { env });
    const response = await forward(new Request('https://x/api/v1/health'), d, 'public');
    expect(response.status).toBe(503);
    expect(d.seen).toHaveLength(0);
  });
});
