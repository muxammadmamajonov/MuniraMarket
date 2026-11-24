import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppBindings } from '../../src/http/context.ts';
import {
  call,
  createTestApp,
  hasDatabase,
  resetDatabase,
  testDatabase,
} from '../helpers/harness.ts';
import { createUser } from '../helpers/fixtures.ts';
import { signedHeaders, type SignOptions } from '../unit/security/helpers.ts';

const SESSION = '/api/v1/internal/telegram/session';
const ME = '/api/v1/internal/telegram/me';
const CLAIM = '/api/v1/internal/telegram/notifications/claim';
const CLEANUP = '/api/v1/internal/maintenance/cleanup';
const CONNECT = '/api/v1/internal/telegram/staff-chat/connect';

describe.skipIf(!hasDatabase)('signed internal routes', () => {
  const db = testDatabase()!;
  let now: number;
  let app: Hono<AppBindings>;

  beforeEach(async () => {
    await resetDatabase(db);
    now = Math.floor(Date.now() / 1000);
    app = createTestApp({ db, clock: () => now });
  });

  function signed(
    method: string,
    path: string,
    options: Omit<SignOptions, 'method' | 'path'> & { json?: unknown } = {},
  ) {
    const body = options.json === undefined ? options.body : JSON.stringify(options.json);
    const headers = signedHeaders({
      ...options,
      method,
      path,
      timestamp: options.timestamp ?? now,
      ...(body !== undefined ? { body } : {}),
    });
    return call(app, method, path, {
      headers,
      entrance: 'public',
      ...(body !== undefined ? { body } : {}),
    });
  }

  async function insertOutbox(
    overrides: { attempts?: number; lockedFor?: number; availableIn?: number } = {},
  ) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO notification_outbox (event_type, payload, created_at, available_at, attempts, locked_until)
       VALUES ('order.status_changed', $1::jsonb, to_timestamp($2::float8), to_timestamp($3::float8), $4,
               CASE WHEN $5::float8 IS NULL THEN NULL ELSE to_timestamp($5::float8) END)
       RETURNING id::text AS id`,
      [
        JSON.stringify({
          order_id: crypto.randomUUID(),
          order_number: 'MM-1',
          status: 'CONFIRMED',
          locale: 'uz',
          total_uzs: 1000,
          chat_id: 42,
        }),
        now - 10,
        now + (overrides.availableIn ?? -10),
        overrides.attempts ?? 0,
        overrides.lockedFor === undefined ? null : now + overrides.lockedFor,
      ],
    );
    return rows[0]!.id;
  }

  describe('service authentication (ADR 0003)', () => {
    const profile = { telegram_user_id: 77, first_name: 'Bot user' };

    it('accepts a correctly signed request with an actor', async () => {
      const response = await signed('POST', SESSION, { actor: 'tg:77', json: profile });
      expect(response.status).toBe(200);
      expect(
        ((await response.json()) as { user: { telegram_user_id: number } }).user.telegram_user_id,
      ).toBe(77);
      expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it.each([
      ['a bad signature', { secret: 'x'.repeat(48) }],
      ['an unknown key', { keyId: 'nope' }],
      ['a skewed timestamp', { timestamp: Math.floor(Date.now() / 1000) - 301 }],
    ])('rejects %s with a generic 401', async (_label, override) => {
      const headers = signedHeaders({
        method: 'POST',
        path: SESSION,
        actor: 'tg:77',
        body: JSON.stringify(profile),
        timestamp: now,
        ...override,
      });
      const response = await call(app, 'POST', SESSION, { headers, body: JSON.stringify(profile) });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: { code: 'unauthorized', message: 'Unauthorized' },
      });
      expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it('rejects a tampered body, path, method or actor', async () => {
      const body = JSON.stringify(profile);
      const headers = signedHeaders({
        method: 'POST',
        path: SESSION,
        actor: 'tg:77',
        body,
        timestamp: now,
      });
      const tampered = await call(app, 'POST', SESSION, {
        headers,
        body: JSON.stringify({ ...profile, first_name: 'Evil' }),
      });
      expect(tampered.status).toBe(401);
      const otherPath = await call(app, 'POST', `${SESSION}?x=1`, { headers, body });
      expect(otherPath.status).toBe(401);
      const otherActor = await call(app, 'POST', SESSION, {
        headers: { ...headers, 'x-mm-actor': 'tg:78' },
        body,
      });
      expect(otherActor.status).toBe(401);
      const unsigned = await call(app, 'POST', SESSION, { json: profile });
      expect(unsigned.status).toBe(401);
    });

    it('rejects a replayed nonce', async () => {
      const body = JSON.stringify(profile);
      const headers = signedHeaders({
        method: 'POST',
        path: SESSION,
        actor: 'tg:77',
        body,
        timestamp: now,
      });
      expect((await call(app, 'POST', SESSION, { headers, body })).status).toBe(200);
      const replay = await call(app, 'POST', SESSION, { headers, body });
      expect(replay.status).toBe(401);
    });

    it('validates the body only after the signature, without a body prefix', async () => {
      const unsigned = await call(app, 'POST', SESSION, { body: '{not json' });
      expect(unsigned.status).toBe(401);
      const invalid = await signed('POST', SESSION, {
        actor: 'tg:77',
        json: { telegram_user_id: 77, extra: 1 },
      });
      expect(invalid.status).toBe(422);
      expect(await invalid.json()).toEqual({
        error: {
          code: 'validation_error',
          message: 'Request validation failed',
          details: [
            { loc: ['first_name'], msg: 'Field required' },
            { loc: ['extra'], msg: 'Extra inputs are not permitted' },
          ],
        },
      });
    });

    it('requires an actor that matches the body', async () => {
      const noActor = await signed('POST', SESSION, { json: profile });
      expect(noActor.status).toBe(403);
      expect(await noActor.json()).toEqual({
        error: { code: 'forbidden', message: 'Actor required' },
      });
      const mismatch = await signed('POST', SESSION, { actor: 'tg:78', json: profile });
      expect(mismatch.status).toBe(403);
      expect(((await mismatch.json()) as { error: { message: string } }).error.message).toBe(
        'Actor does not match request body',
      );
    });

    it('caps the body before verifying it', async () => {
      const body = 'x'.repeat(64 * 1024 + 1);
      const response = await signed('POST', SESSION, { actor: 'tg:77', body });
      expect(response.status).toBe(413);
    });
  });

  describe('/internal/telegram', () => {
    it('upserts and reads the acting user; blocked users are refused', async () => {
      const created = await signed('POST', SESSION, {
        actor: 'tg:91',
        json: { telegram_user_id: 91, first_name: 'Ali', language_code: 'ru-RU', username: null },
      });
      const user = ((await created.json()) as { user: Record<string, unknown> }).user;
      expect(user).toMatchObject({
        telegram_user_id: 91,
        language: 'ru',
        role: 'customer',
        username: null,
      });
      const me = await signed('GET', ME, { actor: 'tg:91' });
      expect(await me.json()).toEqual({ user });
      await db.query('UPDATE users SET is_blocked = true WHERE telegram_user_id = 91');
      const blocked = await signed('POST', SESSION, {
        actor: 'tg:91',
        json: { telegram_user_id: 91, first_name: 'Ali' },
      });
      expect(blocked.status).toBe(403);
      expect(await blocked.json()).toEqual({
        error: { code: 'forbidden', message: 'Account is blocked' },
      });
      const hidden = await signed('GET', ME, { actor: 'tg:91' });
      expect(hidden.status).toBe(404);
      expect(await hidden.json()).toEqual({
        error: { code: 'not_found', message: 'User not found' },
      });
    });
  });

  describe('/internal/telegram/notifications', () => {
    it('claims due rows oldest first with a lease, empty body = default limit', async () => {
      const first = await insertOutbox();
      await insertOutbox({ availableIn: 600 }); // backing off
      await insertOutbox({ lockedFor: 30 }); // leased elsewhere
      const response = await signed('POST', CLAIM);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        items: Array<Record<string, unknown>>;
        lease_expires_at: string;
      };
      expect(body.items).toEqual([
        expect.objectContaining({ id: first, event_type: 'order.status_changed', attempts: 1 }),
      ]);
      expect(Object.keys(body.items[0]!)).toEqual(['id', 'event_type', 'payload', 'attempts']);
      expect(body.lease_expires_at).toBe(
        new Date((now + 60) * 1000).toISOString().replace('.000Z', 'Z'),
      );
    });

    it('reports results with attempt fencing', async () => {
      const id = await insertOutbox();
      await signed('POST', CLAIM, { json: { limit: 5 } });
      const path = `/api/v1/internal/telegram/notifications/${id}/result`;
      const stale = await signed('POST', path, { json: { attempt: 2, outcome: 'delivered' } });
      expect(stale.status).toBe(404);
      expect(await stale.json()).toEqual({
        error: { code: 'not_found', message: 'Message not found' },
      });
      const ok = await signed('POST', path, {
        json: { attempt: 1, outcome: 'retry', error_code: 'bot_api_429' },
      });
      expect(ok.status).toBe(204);
      const { rows } = await db.query(
        `SELECT locked_until, last_error, processed_at, extract(epoch FROM available_at)::float8 - $2 AS delay
         FROM notification_outbox WHERE id = $1`,
        [id, now],
      );
      expect(rows[0]).toMatchObject({
        locked_until: null,
        last_error: 'bot_api_429',
        processed_at: null,
        delay: 30,
      });
      const again = await signed('POST', path, { json: { attempt: 1, outcome: 'delivered' } });
      expect(again.status).toBe(404);
    });

    it('validates after the signature and refuses actors', async () => {
      expect((await signed('POST', CLAIM, { json: { limit: 51 } })).status).toBe(422);
      expect((await signed('POST', CLAIM, { json: { limit: 5, x: 1 } })).status).toBe(422);
      const badPath = await signed(
        'POST',
        '/api/v1/internal/telegram/notifications/not-a-uuid/result',
        {
          json: { attempt: 1, outcome: 'delivered' },
        },
      );
      expect(badPath.status).toBe(422);
      expect(((await badPath.json()) as { error: { details: unknown } }).error.details).toEqual([
        { loc: ['path', 'message_id'], msg: 'Input should be a valid UUID' },
      ]);
      const unsignedBadPath = await call(
        app,
        'POST',
        '/api/v1/internal/telegram/notifications/not-a-uuid/result',
        {
          json: {},
        },
      );
      expect(unsignedBadPath.status).toBe(401);
      const actor = await signed('POST', CLAIM, { actor: 'tg:5' });
      expect(actor.status).toBe(403);
      expect(await actor.json()).toEqual({
        error: { code: 'forbidden', message: 'Service requests only' },
      });
      const { rows } = await db.query('SELECT 1 FROM notification_outbox WHERE attempts > 0');
      expect(rows).toHaveLength(0);
    });
  });

  describe('/internal/telegram/staff-chat/connect', () => {
    it('lets only a non-blocked admin connect the group, with an audit row', async () => {
      const admin = await createUser(db, { role: 'admin' });
      const operator = await createUser(db, { role: 'operator' });
      const body = { chat_id: -1001234567890, chat_type: 'supergroup' };
      const refused = await signed('POST', CONNECT, {
        actor: `tg:${operator.telegram_user_id}`,
        json: body,
      });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({
        error: { code: 'forbidden', message: 'Admin role required' },
      });
      const ok = await signed('POST', CONNECT, {
        actor: `tg:${admin.telegram_user_id}`,
        json: body,
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ connected: true });
      const { rows } = await db.query<{ chat_id: number; connected_by_user_id: string }>(
        'SELECT chat_id, connected_by_user_id::text AS connected_by_user_id FROM staff_notification_chat',
      );
      expect(rows).toEqual([{ chat_id: -1001234567890, connected_by_user_id: admin.id }]);
      const audit = await db.query(
        'SELECT actor_role::text AS role, action, entity_type, entity_id, details FROM audit_log',
      );
      expect(audit.rows).toEqual([
        {
          role: 'admin',
          action: 'staff_chat.connect',
          entity_type: 'staff_chat',
          entity_id: '1',
          details: {},
        },
      ]);
      const privateChat = await signed('POST', CONNECT, {
        actor: `tg:${admin.telegram_user_id}`,
        json: { chat_id: 5, chat_type: 'group' },
      });
      expect(privateChat.status).toBe(422);
    });
  });

  describe('/internal/maintenance/cleanup', () => {
    it('deletes only expired security state and is idempotent', async () => {
      const expired = `to_timestamp(${now - 1})`;
      const live = `to_timestamp(${now + 600})`;
      for (const at of [expired, live]) {
        await db.query(
          `INSERT INTO auth_sessions (token_hash, record, expires_at) VALUES (md5(random()::text) || md5(random()::text), '{"rotated_to":"x"}', ${at})`,
        );
        await db.query(
          `INSERT INTO rate_limit_counters (bucket, hits, expires_at) VALUES (md5(random()::text), 1, ${at})`,
        );
        await db.query(
          `INSERT INTO service_request_nonces (key_id, nonce, expires_at) VALUES ('tg', md5(random()::text), ${at})`,
        );
        await db.query(
          `INSERT INTO oidc_login_states (state_hash, binding_hash, entrance, code_verifier, nonce, return_to, created_at_epoch, expires_at)
           VALUES (md5(random()::text), 'b', 'storefront', 'v', 'n', '/', 0, ${at})`,
        );
      }
      const counts = async () => {
        const { rows } = await db.query<{ n: number }>(
          `SELECT (SELECT count(*) FROM auth_sessions) + (SELECT count(*) FROM rate_limit_counters)
             + (SELECT count(*) FROM service_request_nonces)
             + (SELECT count(*) FROM oidc_login_states) AS n`,
        );
        return Number(rows[0]?.n);
      };
      expect(await counts()).toBe(8);
      const first = await signed('POST', CLEANUP, { keyId: 'scheduler' });
      expect(first.status).toBe(204);
      expect(await first.text()).toBe('');
      // The request's own nonce is live; everything expired is gone.
      expect(await counts()).toBe(4 + 1);
      const second = await signed('POST', CLEANUP, { keyId: 'scheduler' });
      expect(second.status).toBe(204);
      expect(await counts()).toBe(4 + 2);
      expect((await signed('POST', CLEANUP, { actor: 'tg:1' })).status).toBe(403);
      expect((await call(app, 'POST', CLEANUP)).status).toBe(401);
    });
  });
});
