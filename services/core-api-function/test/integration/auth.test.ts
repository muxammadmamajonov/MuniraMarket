import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { AppBindings } from '../../src/http/context.ts';
import { hashToken } from '../../src/security/session.ts';
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
import { createSession, createUser } from '../helpers/fixtures.ts';
import { hmacInitData } from '../unit/security/helpers.ts';

const INIT_DATA = '/api/v1/auth/telegram/init-data';
const SESSION = '/api/v1/auth/session';
const LOGOUT = '/api/v1/auth/logout';
const DAY = 86_400;

describe.skipIf(!hasDatabase)('auth routes (initData sessions)', () => {
  const db = testDatabase()!;
  let now: number;
  let app: Hono<AppBindings>;

  beforeEach(async () => {
    await resetDatabase(db);
    now = Math.floor(Date.now() / 1000);
    app = createTestApp({ db, clock: () => now });
  });

  async function login(
    user: Record<string, unknown> = { id: 501, first_name: 'Munira', language_code: 'ru' },
    cookie?: string,
  ) {
    return call(app, 'POST', INIT_DATA, {
      json: { init_data: hmacInitData(user, { authDate: now }) },
      headers: { origin: WEB_ORIGIN },
      ...(cookie ? { cookie } : {}),
    });
  }

  function sessionCookie(response: Response): string {
    const token = setCookies(response).get('mm_session');
    if (!token) throw new Error('no session cookie');
    return `mm_session=${token}`;
  }

  async function liveSessions(): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM auth_sessions WHERE NOT record ? 'rotated_to' AND expires_at > now()",
    );
    return rows[0]?.n ?? 0;
  }

  it('signs in with initData, upserts the user and sets the exact cookie', async () => {
    const response = await login();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: Record<string, unknown>; csrf_token: string };
    expect(Object.keys(body)).toEqual(['user', 'csrf_token']);
    expect(Object.keys(body.user)).toEqual([
      'id',
      'telegram_user_id',
      'first_name',
      'last_name',
      'username',
      'language',
      'role',
      'language_confirmed',
      'phone_verified',
      'phone_hint',
    ]);
    expect(body.user).toMatchObject({
      telegram_user_id: 501,
      first_name: 'Munira',
      last_name: null,
      language: 'ru',
      role: 'customer',
    });
    const [cookie] = response.headers.getSetCookie();
    expect(cookie).toMatch(
      /^mm_session=[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax$/,
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    // Only the hash is stored.
    const token = setCookies(response).get('mm_session')!;
    const { rows } = await db.query('SELECT 1 FROM auth_sessions WHERE token_hash = $1', [
      hashToken(token),
    ]);
    expect(rows).toHaveLength(1);
  });

  it('keeps the language a user picked later', async () => {
    await login();
    await db.query("UPDATE users SET language = 'uz' WHERE telegram_user_id = 501");
    const second = await login({ id: 501, first_name: 'New', language_code: 'ru' });
    expect(
      ((await second.json()) as { user: { language: string; first_name: string } }).user,
    ).toMatchObject({
      language: 'uz',
      first_name: 'New',
    });
  });

  it('rejects invalid initData without a cookie', async () => {
    const response = await call(app, 'POST', INIT_DATA, {
      json: { init_data: 'auth_date=1&hash=abc' },
      headers: { origin: WEB_ORIGIN },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: 'invalid_telegram_auth', message: 'Invalid Telegram init data' },
    });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('validates the body after the origin check, and malformed JSON first', async () => {
    const untrusted = await call(app, 'POST', INIT_DATA, {
      json: { nope: 1 },
      headers: { origin: 'https://evil.example' },
    });
    expect(untrusted.status).toBe(403);
    expect(((await untrusted.json()) as { error: { code: string } }).error.code).toBe(
      'csrf_failed',
    );
    const invalid = await call(app, 'POST', INIT_DATA, {
      json: { init_data: '' },
      headers: { origin: WEB_ORIGIN },
    });
    expect(invalid.status).toBe(422);
    const malformed = await call(app, 'POST', INIT_DATA, {
      body: '{"init_data":',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    });
    expect(malformed.status).toBe(422);
  });

  it('rotates away the session presented at login (anti-fixation)', async () => {
    const first = sessionCookie(await login());
    const second = await login(undefined, first);
    expect(second.status).toBe(200);
    expect(sessionCookie(second)).not.toBe(first);
    expect((await call(app, 'GET', SESSION, { cookie: first })).status).toBe(401);
    expect(await liveSessions()).toBe(1);
    // Signing in as another user also drops the old session.
    const other = await login({ id: 502, first_name: 'Other' }, sessionCookie(second));
    expect(other.status).toBe(200);
    expect((await call(app, 'GET', SESSION, { cookie: sessionCookie(second) })).status).toBe(401);
  });

  it('refuses a blocked user and clears the presented session', async () => {
    const cookie = sessionCookie(await login());
    await db.query('UPDATE users SET is_blocked = true WHERE telegram_user_id = 501');
    const response = await login(undefined, cookie);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'account_blocked',
    );
    expect(response.headers.getSetCookie()[0]).toMatch(/^mm_session=""; expires=Thu, 01 Jan 1970/);
    expect(await liveSessions()).toBe(0);
  });

  it('looks the session up and requires one', async () => {
    const response = await login();
    const { csrf_token } = (await response.json()) as { csrf_token: string };
    const me = await call(app, 'GET', SESSION, { cookie: sessionCookie(response) });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { csrf_token: string }).csrf_token).toBe(csrf_token);
    const anonymous = await call(app, 'GET', SESSION);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({
      error: { code: 'session_required', message: 'Sign-in required' },
    });
    // An unknown cookie is not cleared (it may have raced a rotation).
    const unknown = await call(app, 'GET', SESSION, { cookie: `mm_session=${'A'.repeat(43)}` });
    expect(unknown.status).toBe(401);
    expect(unknown.headers.getSetCookie()).toEqual([]);
  });

  it('slides the idle expiry and enforces the absolute lifetime', async () => {
    let cookie = sessionCookie(await login());
    // Idle TTL is 7 days: each use slides it (and rotates the token: follow the cookie).
    for (let i = 0; i < 4; i += 1) {
      now += 6 * DAY;
      const response = await call(app, 'GET', SESSION, { cookie });
      expect(response.status).toBe(200);
      cookie = sessionCookie(response);
    }
    const idle = sessionCookie(await login({ id: 503, first_name: 'Idle' }));
    now += 7 * DAY + 1;
    expect((await call(app, 'GET', SESSION, { cookie: idle })).status).toBe(401);
    // Absolute lifetime (30 days since creation) ends even an active session.
    expect((await call(app, 'GET', SESSION, { cookie })).status).toBe(401);
  });

  it('rotates after the threshold, keeps the CSRF token and honours the grace period', async () => {
    const response = await login();
    const { csrf_token } = (await response.json()) as { csrf_token: string };
    const old = sessionCookie(response);
    now += DAY + 1;
    const rotated = await call(app, 'GET', SESSION, { cookie: old });
    expect(rotated.status).toBe(200);
    expect(((await rotated.json()) as { csrf_token: string }).csrf_token).toBe(csrf_token);
    const fresh = sessionCookie(rotated);
    expect(fresh).not.toBe(old);
    expect(rotated.headers.getSetCookie()[0]).toMatch(/Max-Age=2505599;/);
    // A parallel request with the old cookie inside the grace period: served, no new cookie.
    const parallel = await call(app, 'GET', SESSION, { cookie: old });
    expect(parallel.status).toBe(200);
    expect(parallel.headers.getSetCookie()).toEqual([]);
    expect((await call(app, 'GET', SESSION, { cookie: fresh })).status).toBe(200);
    // After the grace period the old token is gone.
    now += 61;
    expect((await call(app, 'GET', SESSION, { cookie: old })).status).toBe(401);
    expect((await call(app, 'GET', SESSION, { cookie: fresh })).status).toBe(200);
  });

  it('blocking seen through the old token revokes the new one too', async () => {
    const old = sessionCookie(await login());
    now += DAY + 1;
    const fresh = sessionCookie(await call(app, 'GET', SESSION, { cookie: old }));
    await db.query('UPDATE users SET is_blocked = true WHERE telegram_user_id = 501');
    const blocked = await call(app, 'GET', SESSION, { cookie: old });
    expect(blocked.status).toBe(403);
    expect(blocked.headers.getSetCookie()[0]).toMatch(/^mm_session=""/);
    await db.query('UPDATE users SET is_blocked = false WHERE telegram_user_id = 501');
    expect((await call(app, 'GET', SESSION, { cookie: fresh })).status).toBe(401);
  });

  it('rejects the session of a deleted or mismatched user and clears the cookie', async () => {
    const user = await createUser(db);
    const session = await createSession(db, user);
    await db.query('UPDATE users SET telegram_user_id = telegram_user_id + 1 WHERE id = $1', [
      user.id,
    ]);
    const response = await call(app, 'GET', SESSION, { cookie: session.cookie });
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()[0]).toMatch(/^mm_session=""/);
  });

  it('logs out with the CSRF token, idempotently', async () => {
    const response = await login();
    const { csrf_token } = (await response.json()) as { csrf_token: string };
    const cookie = sessionCookie(response);
    const refused = await call(app, 'POST', LOGOUT, { cookie, headers: { origin: WEB_ORIGIN } });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('csrf_failed');
    const out = await call(app, 'POST', LOGOUT, {
      cookie,
      headers: { origin: WEB_ORIGIN, 'x-csrf-token': csrf_token },
    });
    expect(out.status).toBe(204);
    expect(await out.text()).toBe('');
    expect(out.headers.getSetCookie()).toEqual([
      'mm_session=""; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
    ]);
    expect((await call(app, 'GET', SESSION, { cookie })).status).toBe(401);
    const again = await call(app, 'POST', LOGOUT, { cookie, headers: { origin: WEB_ORIGIN } });
    expect(again.status).toBe(204);
    const untrusted = await call(app, 'POST', LOGOUT, {
      headers: { origin: 'https://evil.example' },
    });
    expect(untrusted.status).toBe(403);
  });

  it('logout with a rotated-away token in its grace period ends both', async () => {
    const response = await login();
    const { csrf_token } = (await response.json()) as { csrf_token: string };
    const old = sessionCookie(response);
    now += DAY + 1;
    const fresh = sessionCookie(await call(app, 'GET', SESSION, { cookie: old }));
    const out = await call(app, 'POST', LOGOUT, {
      cookie: old,
      headers: { origin: WEB_ORIGIN, 'x-csrf-token': csrf_token },
    });
    expect(out.status).toBe(204);
    expect((await call(app, 'GET', SESSION, { cookie: fresh })).status).toBe(401);
  });

  it('rate limits per IP with Retry-After and no-store', async () => {
    for (let i = 0; i < 60; i += 1) {
      expect((await call(app, 'GET', SESSION, { ip: '198.51.100.7' })).status).toBe(401);
    }
    const limited = await call(app, 'GET', SESSION, { ip: '198.51.100.7' });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({
      error: { code: 'rate_limited', message: 'Too many requests' },
    });
    const retryAfter = Number(limited.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(limited.headers.get('cache-control')).toBe('no-store');
    // Another IP is unaffected; the next window starts over.
    expect((await call(app, 'GET', SESSION, { ip: '198.51.100.8' })).status).toBe(401);
    now += 60;
    expect((await call(app, 'GET', SESSION, { ip: '198.51.100.7' })).status).toBe(401);
  });

  it('reports OIDC as disabled by default', async () => {
    const response = await call(app, 'GET', '/api/v1/auth/config');
    expect(await response.json()).toEqual({ telegram_oidc: { enabled: false } });
    const start = await call(app, 'POST', '/api/v1/auth/telegram/oidc/start', {
      json: {},
      headers: { origin: WEB_ORIGIN },
    });
    expect(start.status).toBe(404);
    expect(((await start.json()) as { error: { code: string } }).error.code).toBe(
      'feature_disabled',
    );
  });

  it('fails closed with 503 when the security store is unavailable', async () => {
    const cookie = sessionCookie(await login());
    const broken = createTestApp({
      db: Object.assign(Object.create(Object.getPrototypeOf(db)), db, {
        storeTx: async () => {
          const { StoreUnavailableError } = await import('../../src/errors.ts');
          throw new StoreUnavailableError();
        },
      }),
      clock: () => now,
    });
    const response = await call(broken, 'GET', SESSION, { cookie });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: 'service_unavailable', message: 'Service temporarily unavailable' },
    });
  });

  it('uses the admin origin too', async () => {
    const response = await call(app, 'POST', INIT_DATA, {
      json: { init_data: hmacInitData({ id: 9, first_name: 'A' }, { authDate: now }) },
      headers: { origin: ADMIN_ORIGIN },
    });
    expect(response.status).toBe(200);
  });
});
