import { beforeEach, describe, expect, it } from 'vitest';
import { RULES } from '../../src/http/auth.ts';
import { hitRateLimit } from '../../src/security/rateLimit.ts';
import { registerNonce } from '../../src/security/serviceAuth.ts';
import { securityServices } from '../../src/security/services.ts';
import { hashToken, SessionGoneError, SwapResult } from '../../src/security/session.ts';
import { hasDatabase, resetDatabase, testDatabase, testDeps } from '../helpers/harness.ts';
import { createUser } from '../helpers/fixtures.ts';

/** PostgreSQL-backed security stores under concurrency (port of test_security_state_integration). */
describe.skipIf(!hasDatabase)('security state in PostgreSQL', () => {
  const db = testDatabase()!;
  let now: number;
  const clock = () => now;

  beforeEach(async () => {
    await resetDatabase(db);
    now = Math.floor(Date.now() / 1000);
  });

  function services(env: Record<string, string> = {}) {
    return securityServices(testDeps({ db, clock, env }));
  }

  async function newSession(env: Record<string, string> = {}) {
    const { sessions } = services(env);
    const user = await createUser(db);
    const issued = await sessions.create({
      userId: user.id,
      telegramUserId: user.telegram_user_id,
      authMethod: 'telegram_init_data',
      entrance: 'storefront',
      previousToken: null,
    });
    return { sessions, user, issued };
  }

  it('stores only the token hash and hides expired rows without cleanup', async () => {
    const { sessions, issued } = await newSession();
    const { rows } = await db.query<{ token_hash: string; record: Record<string, unknown> }>(
      'SELECT token_hash, record FROM auth_sessions',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(hashToken(issued.token));
    expect(JSON.stringify(rows[0])).not.toContain(issued.token);
    expect(Object.keys(rows[0]!.record)).toEqual(
      expect.arrayContaining([
        'user_id',
        'telegram_user_id',
        'csrf_token',
        'auth_method',
        'created_at',
        'last_rotated_at',
        'entrance',
      ]),
    );
    now += 7 * 86_400 + 1;
    expect(await sessions.peek(issued.token)).toBeNull();
    const { rows: still } = await db.query('SELECT 1 FROM auth_sessions');
    expect(still).toHaveLength(1);
  });

  it('parallel rotation of the same token never forks the session', async () => {
    const { sessions, issued } = await newSession();
    now += 86_401;
    const loaded = await Promise.all(Array.from({ length: 5 }, () => sessions.load(issued.token)));
    const results = await Promise.all(loaded.map((l) => sessions.rotateIfDue(l!)));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const { rows } = await db.query("SELECT 1 FROM auth_sessions WHERE NOT record ? 'rotated_to'");
    expect(rows).toHaveLength(1);
  });

  it('rotation after a concurrent logout is gone, and nothing stays live', async () => {
    const { sessions, issued } = await newSession();
    now += 86_401;
    const loaded = await sessions.load(issued.token);
    await sessions.revoke(issued.token);
    await expect(sessions.rotateIfDue(loaded!)).rejects.toBeInstanceOf(SessionGoneError);
    const { rows } = await db.query('SELECT 1 FROM auth_sessions');
    expect(rows).toHaveLength(0);
  });

  it('replace reports GONE, SWAPPED and ALREADY_ROTATED', async () => {
    const { issued } = await newSession();
    const store = services().sessionStore;
    const old = hashToken(issued.token);
    const next = 'b'.repeat(64);
    expect(await store.replace(old, next, issued.data, 60, 30)).toBe(SwapResult.SWAPPED);
    expect(await store.replace(old, 'c'.repeat(64), issued.data, 60, 30)).toBe(
      SwapResult.ALREADY_ROTATED,
    );
    expect(await store.replace('d'.repeat(64), 'e'.repeat(64), issued.data, 60, 30)).toBe(
      SwapResult.GONE,
    );
  });

  it('grace 0 restores the strict swap', async () => {
    const { sessions, issued } = await newSession({ SESSION_ROTATION_GRACE_SECONDS: '0' });
    now += 86_401;
    const rotated = await sessions.rotateIfDue((await sessions.load(issued.token))!);
    expect(rotated).not.toBeNull();
    expect(await sessions.load(issued.token)).toBeNull();
    expect(await sessions.load(rotated!.token)).not.toBeNull();
  });

  it('discards malformed records', async () => {
    const { sessions, issued } = await newSession();
    await db.query(`UPDATE auth_sessions SET record = '{"user_id": "x"}'`);
    expect(await sessions.load(issued.token)).toBeNull();
    const { rows } = await db.query('SELECT 1 FROM auth_sessions');
    expect(rows).toHaveLength(0);
  });

  it('revokeUser removes every live session of a user', async () => {
    const { sessions, user, issued } = await newSession();
    const second = await sessions.create({
      userId: user.id,
      telegramUserId: user.telegram_user_id,
      authMethod: 'telegram_oidc',
      entrance: 'admin',
      previousToken: null,
    });
    const other = await newSession();
    await sessions.revokeUser(user.id);
    expect(await sessions.peek(issued.token)).toBeNull();
    expect(await sessions.peek(second.token)).toBeNull();
    expect(await sessions.peek(other.issued.token)).not.toBeNull();
  });

  it('counts concurrent rate-limit hits exactly', async () => {
    const decisions = await Promise.all(
      Array.from({ length: 25 }, () => hitRateLimit(db, clock, RULES.AUTH_LOGIN, '192.0.2.1')),
    );
    expect(decisions.filter((d) => d.allowed)).toHaveLength(10);
    const { rows } = await db.query<{ hits: number }>('SELECT hits FROM rate_limit_counters');
    expect(rows).toEqual([{ hits: 25 }]);
  });

  it('accepts a nonce once, even concurrently, and again after it expired', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => registerNonce(db, clock, 'tg', 'nonce-nonce-nonce-1', 660)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await registerNonce(db, clock, 'scheduler', 'nonce-nonce-nonce-1', 660)).toBe(true);
    now += 661;
    expect(await registerNonce(db, clock, 'tg', 'nonce-nonce-nonce-1', 660)).toBe(true);
  });

  it('consumes an OIDC state exactly once and refuses expired ones', async () => {
    const { oidcStates } = services();
    const login = {
      bindingHash: 'a'.repeat(64),
      entrance: 'admin' as const,
      codeVerifier: 'v'.repeat(86),
      nonce: 'n',
      returnTo: '/uz',
      createdAt: now,
    };
    await oidcStates.put('s'.repeat(64), login, 600);
    const taken = await Promise.all(
      Array.from({ length: 4 }, () => oidcStates.take('s'.repeat(64))),
    );
    expect(taken.filter((t) => t !== null)).toEqual([login]);
    await oidcStates.put('t'.repeat(64), login, 600);
    now += 601;
    expect(await oidcStates.take('t'.repeat(64))).toBeNull();
  });
});
