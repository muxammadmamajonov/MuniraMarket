import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppBindings, Ctx } from '../../src/http/context.ts';
import {
  backOfficeRouterDeps,
  requireAdminWriter,
  requireStaff,
} from '../../src/security/adminDeps.ts';
import { csrfProtectedUser } from '../../src/security/sessionDeps.ts';
import { codeChallenge } from '../../src/telegram/oidc.ts';
import {
  ADMIN_ORIGIN,
  call,
  createTestApp,
  hasDatabase,
  resetDatabase,
  setCookies,
  testDatabase,
  WEB_ORIGIN,
} from '../helpers/harness.ts';
import { createSession, createStaff, createUser } from '../helpers/fixtures.ts';
import { hmacInitData, rsaSigner } from '../unit/security/helpers.ts';

const ISSUER = 'https://oauth.telegram.org';
const CLIENT_ID = 777;
const TG_ID = 4242;
const START = '/api/v1/auth/telegram/oidc/start';
const CALLBACK = '/api/v1/auth/telegram/oidc/callback';
const PROBE = '/api/v1/admin/zz-security-probe/x/y';
const OIDC_ENV = {
  TELEGRAM_OIDC_ENABLED: 'true',
  TELEGRAM_OIDC_CLIENT_ID: String(CLIENT_ID),
  TELEGRAM_OIDC_CLIENT_SECRET: 'test-only-client-secret',
  WEB_PUBLIC_ORIGIN: WEB_ORIGIN,
  ADMIN_PUBLIC_ORIGIN: ADMIN_ORIGIN,
};

/** A fake Telegram OIDC provider behind the injected `fetch`. */
class FakeProvider {
  readonly signer = rsaSigner();
  readonly nonceForCode = new Map<string, string>();
  readonly exchanges: Array<Record<string, string>> = [];
  fail = false;
  now = 0;

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === `${ISSUER}/.well-known/jwks.json`) {
      return Response.json({ keys: [this.signer.publicJwk] });
    }
    if (url === `${ISSUER}/token` && init?.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(String(init.body)));
      this.exchanges.push(form);
      if (this.fail) return new Response('denied', { status: 400 });
      const code = form['code'] ?? '';
      return Response.json({
        id_token: this.signer.token({
          iss: ISSUER,
          aud: String(CLIENT_ID),
          sub: 'opaque-sub',
          id: TG_ID,
          exp: this.now + 300,
          iat: this.now,
          nonce: this.nonceForCode.get(code) ?? '?',
          given_name: 'Munira',
        }),
      });
    }
    throw new Error(`unexpected request to ${url}`);
  };
}

describe.skipIf(!hasDatabase)('Telegram OIDC sign-in and back-office sessions', () => {
  const db = testDatabase()!;
  let now: number;
  let fake: FakeProvider;
  let app: Hono<AppBindings>;

  beforeEach(async () => {
    await resetDatabase(db);
    now = Math.floor(Date.now() / 1000);
    fake = new FakeProvider();
    fake.now = now;
    app = createTestApp({ db, clock: () => now, fetch: fake.fetch, env: OIDC_ENV });
    app.get(PROBE, async (c) => {
      await backOfficeRouterDeps(c as Ctx);
      const user = await requireStaff(c as Ctx);
      return c.json({ role: user.role });
    });
    app.post(PROBE, async (c) => {
      await backOfficeRouterDeps(c as Ctx);
      const user = await requireAdminWriter(c as Ctx);
      return c.json({ role: user.role });
    });
    app.post('/api/v1/cart/zz-security-probe', async (c) => {
      const user = await csrfProtectedUser(c as Ctx);
      return c.json({ id: user.id });
    });
  });

  async function start(
    entrance: 'storefront' | 'admin' = 'storefront',
    returnTo: string | null = '/uz/orders',
  ) {
    const response = await call(app, 'POST', START, {
      entrance,
      json: returnTo === null ? {} : { return_to: returnTo },
      headers: { origin: entrance === 'admin' ? ADMIN_ORIGIN : WEB_ORIGIN },
    });
    expect(response.status).toBe(200);
    const url = new URL(
      ((await response.json()) as { authorization_url: string }).authorization_url,
    );
    const [binding] = response.headers.getSetCookie();
    expect(binding).toMatch(
      /^mm_oidc=[A-Za-z0-9_-]{43}; Max-Age=600; Path=\/; HttpOnly; SameSite=Lax$/,
    );
    return { url, binding: setCookies(response).get('mm_oidc')! };
  }

  async function callback(
    started: { url: URL; binding: string },
    options: {
      entrance?: 'storefront' | 'admin';
      code?: string | null;
      binding?: string;
      extraCookie?: string;
    } = {},
  ) {
    const code = options.code === undefined ? 'auth-code-1' : options.code;
    const state = started.url.searchParams.get('state')!;
    if (code !== null) fake.nonceForCode.set(code, started.url.searchParams.get('nonce')!);
    const query = new URLSearchParams({ state, ...(code !== null ? { code } : {}) });
    return call(app, 'GET', `${CALLBACK}?${query}`, {
      entrance: options.entrance ?? 'storefront',
      cookie: [`mm_oidc=${options.binding ?? started.binding}`, options.extraCookie]
        .filter(Boolean)
        .join('; '),
    });
  }

  it('reports OIDC as enabled', async () => {
    expect(await (await call(app, 'GET', '/api/v1/auth/config')).json()).toEqual({
      telegram_oidc: { enabled: true },
    });
  });

  it('builds a PKCE authorization request per entrance', async () => {
    const { url } = await start();
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/auth`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: String(CLIENT_ID),
      redirect_uri: `${WEB_ORIGIN}${CALLBACK}`,
      scope: 'openid profile',
      code_challenge_method: 'S256',
    });
    expect(url.searchParams.get('code_challenge')).toHaveLength(43);
    expect(url.search).not.toContain('client_secret');
    const admin = await start('admin');
    expect(admin.url.searchParams.get('redirect_uri')).toBe(`${ADMIN_ORIGIN}${CALLBACK}`);
  });

  it('requires a trusted origin to start', async () => {
    const response = await call(app, 'POST', START, {
      json: {},
      headers: { origin: 'https://evil.example' },
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('csrf_failed');
  });

  it('completes a storefront login and replaces the presented session', async () => {
    const previous = await createSession(db, await createUser(db));
    const again = await start();
    const ok = await callback(again, { extraCookie: previous.cookie });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/uz/orders');
    expect(ok.headers.get('referrer-policy')).toBe('no-referrer');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(await ok.text()).toBe('');
    const cookies = setCookies(ok);
    expect(cookies.get('mm_oidc')).toBe('""');
    const session = cookies.get('mm_session')!;
    const exchange = fake.exchanges.at(-1)!;
    expect(exchange['redirect_uri']).toBe(`${WEB_ORIGIN}${CALLBACK}`);
    expect(codeChallenge(exchange['code_verifier']!)).toBe(
      again.url.searchParams.get('code_challenge'),
    );
    const me = await call(app, 'GET', '/api/v1/auth/session', { cookie: `mm_session=${session}` });
    expect(
      ((await me.json()) as { user: { telegram_user_id: number; first_name: string } }).user,
    ).toMatchObject({
      telegram_user_id: TG_ID,
      first_name: 'Munira',
    });
    const old = await call(app, 'GET', '/api/v1/auth/session', { cookie: previous.cookie });
    expect(old.status).toBe(401);
  });

  it('consumes the state exactly once', async () => {
    const started = await start();
    expect(setCookies(await callback(started)).has('mm_session')).toBe(true);
    const replay = await callback(started, { code: 'auth-code-2' });
    expect(replay.headers.get('location')).toBe('/uz/auth/telegram?status=failed');
    expect(setCookies(replay).has('mm_session')).toBe(false);
    expect(fake.exchanges).toHaveLength(1);
  });

  it('fails in another browser, on the other origin, and for expired states', async () => {
    const other = await callback(await start(), { binding: 'A'.repeat(43) });
    expect(other.headers.get('location')).toBe('/uz/auth/telegram?status=failed');
    const wrongOrigin = await callback(await start('storefront'), { entrance: 'admin' });
    expect(wrongOrigin.headers.get('location')).toBe('/uz/auth/telegram?status=failed');
    const started = await start();
    now += 601;
    expect((await callback(started)).headers.get('location')).toBe(
      '/uz/auth/telegram?status=failed',
    );
    expect(fake.exchanges).toEqual([]);
  });

  it('maps cancelled, failed and malformed callbacks', async () => {
    const cancelled = await callback(await start('storefront', '/ru/cart'), { code: null });
    expect(cancelled.headers.get('location')).toBe('/ru/auth/telegram?status=cancelled');
    fake.fail = true;
    expect((await callback(await start())).headers.get('location')).toBe(
      '/uz/auth/telegram?status=failed',
    );
    for (const query of [`state=${'x'.repeat(43)}&code=c`, 'state=bad&code=c', '']) {
      const response = await call(app, 'GET', `${CALLBACK}?${query}`);
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/uz/auth/telegram?status=failed');
    }
    const tooLong = await call(app, 'GET', `${CALLBACK}?state=${'s'.repeat(65)}`);
    expect(tooLong.status).toBe(422);
    expect(await tooLong.json()).toEqual({
      error: {
        code: 'validation_error',
        message: 'Request validation failed',
        details: [{ loc: ['query', 'state'], msg: 'String should have at most 64 characters' }],
      },
    });
  });

  it('refuses a blocked user', async () => {
    await callback(await start());
    await db.query('UPDATE users SET is_blocked = true WHERE telegram_user_id = $1', [TG_ID]);
    const response = await callback(await start(), { code: 'auth-code-3' });
    expect(response.headers.get('location')).toBe('/uz/auth/telegram?status=blocked');
    expect(setCookies(response).has('mm_session')).toBe(false);
  });

  it('binds sessions to their entrance: only admin-origin OIDC sessions reach the back office', async () => {
    const storefront = setCookies(await callback(await start())).get('mm_session')!;
    await db.query("UPDATE users SET role = 'admin' WHERE telegram_user_id = $1", [TG_ID]);
    const refused = await call(app, 'GET', PROBE, {
      cookie: `mm_session=${storefront}`,
      entrance: 'admin',
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: { code: 'forbidden', message: 'Operator role required' },
    });

    const admin = await callback(await start('admin', '/uz'), {
      entrance: 'admin',
      code: 'auth-code-admin',
    });
    expect(admin.headers.get('location')).toBe('/uz');
    const adminToken = setCookies(admin).get('mm_session')!;
    const allowed = await call(app, 'GET', PROBE, {
      cookie: `mm_session=${adminToken}`,
      entrance: 'admin',
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ role: 'admin' });
  });

  it('refuses Mini App sessions and wrong roles in the back office', async () => {
    const login = await call(app, 'POST', '/api/v1/auth/telegram/init-data', {
      json: { init_data: hmacInitData({ id: 99, first_name: 'Op' }, { authDate: now }) },
      headers: { origin: WEB_ORIGIN },
    });
    await db.query("UPDATE users SET role = 'operator' WHERE telegram_user_id = 99");
    const miniApp = await call(app, 'GET', PROBE, {
      cookie: `mm_session=${setCookies(login).get('mm_session')}`,
    });
    expect(miniApp.status).toBe(403);

    const operator = await createStaff(db, 'operator');
    expect((await call(app, 'GET', PROBE, { cookie: operator.session.cookie })).status).toBe(200);
    const write = await call(app, 'POST', PROBE, {
      cookie: operator.session.cookie,
      headers: operator.session.writeHeaders,
    });
    expect(write.status).toBe(403);
    expect(await write.json()).toEqual({
      error: { code: 'forbidden', message: 'Admin role required' },
    });
    const customer = await createSession(db, await createUser(db), {
      entrance: 'admin',
      authMethod: 'telegram_oidc',
    });
    expect((await call(app, 'GET', PROBE, { cookie: customer.cookie })).status).toBe(403);
    expect((await call(app, 'GET', PROBE)).status).toBe(401);
  });

  it('enforces CSRF on session-authenticated writes', async () => {
    const admin = await createStaff(db, 'admin');
    const ok = await call(app, 'POST', PROBE, {
      cookie: admin.session.cookie,
      headers: admin.session.writeHeaders,
    });
    expect(ok.status).toBe(200);
    const cases: Array<Record<string, string>> = [
      { 'x-csrf-token': admin.session.csrfToken }, // missing origin is allowed only in dev/test
      { origin: 'https://evil.example', 'x-csrf-token': admin.session.csrfToken },
      { origin: ADMIN_ORIGIN },
      { origin: ADMIN_ORIGIN, 'x-csrf-token': `${admin.session.csrfToken}x` },
    ];
    const statuses = [];
    for (const headers of cases) {
      const response = await call(app, 'POST', '/api/v1/cart/zz-security-probe', {
        cookie: admin.session.cookie,
        headers,
      });
      statuses.push(response.status);
      if (response.status === 403) {
        expect(await response.json()).toEqual({
          error: { code: 'csrf_failed', message: 'CSRF validation failed' },
        });
      }
    }
    expect(statuses).toEqual([200, 403, 403, 403]);
  });
});
