/**
 * One canonical language and verified-phone model shared by the bot (signed internal routes) and
 * the storefront (`PUT /me/language`), plus the checkout phone gate.
 */
import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db.ts';
import type { AppBindings } from '../../src/http/context.ts';
import {
  call,
  createTestApp,
  hasDatabase,
  resetDatabase,
  testDatabase,
} from '../helpers/harness.ts';
import { signedHeaders } from '../unit/security/helpers.ts';
import { as, customer, newKey, orderBody, type Customer } from './catalog.seed.ts';

const LANGUAGE = '/api/v1/internal/telegram/language';
const PHONE = '/api/v1/internal/telegram/phone';
const ME_LANGUAGE = '/api/v1/me/language';
const ORDERS = '/api/v1/orders';

describe.skipIf(!hasDatabase)('user preferences', () => {
  const db = testDatabase() as Database;
  let app: Hono<AppBindings>;
  let me: Customer;
  let now: number;

  beforeEach(async () => {
    await resetDatabase(db);
    now = Math.floor(Date.now() / 1000);
    app = createTestApp({ db, clock: () => now });
    me = await customer(db);
  });

  function signed(method: string, path: string, json: unknown, actor = me.user.telegram_user_id) {
    const body = JSON.stringify(json);
    return call(app, method, path, {
      headers: signedHeaders({ method, path, body, actor: `tg:${actor}`, timestamp: now }),
      entrance: 'public',
      body,
    });
  }

  async function row() {
    const { rows } = await db.query<{
      language: string;
      language_confirmed: boolean;
      phone: string | null;
      phone_verified: boolean;
      method: string | null;
    }>(
      `SELECT language::text AS language, language_confirmed_at IS NOT NULL AS language_confirmed,
              phone, phone_verified_at IS NOT NULL AS phone_verified,
              phone_verification_method AS method
         FROM users WHERE id = $1::uuid`,
      [me.user.id],
    );
    return rows[0]!;
  }

  it('the bot onboarding choice is saved and confirmed on the users row', async () => {
    expect(await row()).toMatchObject({ language: 'uz', language_confirmed: false });
    const response = await signed('PUT', LANGUAGE, { language: 'ru' });
    expect(response.status, await response.clone().text()).toBe(200);
    const { user } = (await response.json()) as { user: Record<string, unknown> };
    expect(user).toMatchObject({ language: 'ru', language_confirmed: true, phone_verified: false });
    expect(await row()).toMatchObject({ language: 'ru', language_confirmed: true });
  });

  it('refuses unknown languages and unsigned calls', async () => {
    expect((await signed('PUT', LANGUAGE, { language: 'en' })).status).toBe(422);
    const unsigned = await call(app, 'PUT', LANGUAGE, {
      json: { language: 'ru' },
      entrance: 'public',
    });
    expect(unsigned.status).toBe(401);
  });

  it('the shop profile writes the same column (CSRF-protected, no-store)', async () => {
    const response = await as(app, me).put(ME_LANGUAGE, { language: 'ru' });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await row()).toMatchObject({ language: 'ru', language_confirmed: true });

    const noCsrf = await call(app, 'PUT', ME_LANGUAGE, {
      cookie: me.session.cookie,
      json: { language: 'uz' },
    });
    expect(noCsrf.status).toBe(403);
    expect((await row()).language).toBe('ru');
  });

  it('stores only the sender’s own contact and never echoes the number', async () => {
    const other = await signed('POST', PHONE, {
      contact_user_id: me.user.telegram_user_id + 1,
      phone_number: '+998901234567',
    });
    expect(other.status).toBe(403);
    expect((await row()).phone_verified).toBe(false);

    const own = await signed('POST', PHONE, {
      contact_user_id: me.user.telegram_user_id,
      phone_number: '998 90 123 45 67',
    });
    expect(own.status, await own.clone().text()).toBe(200);
    const text = await own.text();
    expect(text).not.toContain('90123');
    expect(JSON.parse(text).user.phone_hint).toBe('+998 •• ••• 45 67');
    expect(JSON.parse(text).user.phone_verified).toBe(true);
    expect(await row()).toMatchObject({
      phone: '+998901234567',
      phone_verified: true,
      method: 'telegram_contact',
    });
  });

  it('orders need a verified phone when the gate is on', async () => {
    const gated = createTestApp({ db, env: { CHECKOUT_REQUIRE_VERIFIED_PHONE: 'true' } });
    const before = await as(gated, me).post(ORDERS, orderBody(), { 'idempotency-key': newKey() });
    expect(before.status).toBe(409);
    expect(((await before.json()) as { error: { code: string } }).error.code).toBe(
      'phone_verification_required',
    );

    await signed('POST', PHONE, {
      contact_user_id: me.user.telegram_user_id,
      phone_number: '+998901234567',
    });
    // Past the gate: the (empty) cart is the next rule that applies.
    const after = await as(gated, me).post(ORDERS, orderBody(), { 'idempotency-key': newKey() });
    expect(((await after.json()) as { error: { code: string } }).error.code).toBe('cart_empty');
  });
});
