/**
 * Profile hub over HTTP against the Alembic schema (port of test_profile_integration.py):
 * `PATCH /me` (name protection against Telegram sign-ins, phone verification semantics), saved
 * addresses (limit, ownership, default switching and promotion, concurrency) and the order history
 * tabs with their thumbnails (filtered in SQL, two statements per page).
 */
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/db.ts';
import type { AppBindings } from '../../src/http/context.ts';
import { recordTelegramPhone, upsertFromTelegram } from '../../src/repositories/users.ts';
import {
  call,
  createTestApp,
  hasDatabase,
  resetDatabase,
  testDatabase,
} from '../helpers/harness.ts';
import { signedHeaders } from '../unit/security/helpers.ts';
import { addCategory, addProduct, as, customer, errorOf, type Customer } from './catalog.seed.ts';

const ME = '/api/v1/me';
const ADDRESSES = '/api/v1/me/addresses';
const ORDERS = '/api/v1/orders';
const SESSION = '/api/v1/internal/telegram/session';
const ADDRESS = { lat: 41.3110812, lon: 69.2405624, street: 'Amir Temur', house: '1' };
const ORDER_STATUSES = [
  'NEW',
  'CONFIRMED',
  'PICKING',
  'READY_FOR_DELIVERY',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
] as const;

type Json = Record<string, unknown>;

describe.skipIf(!hasDatabase)('profile hub', () => {
  const db = testDatabase() as Database;
  let app: Hono<AppBindings>;
  let me: Customer;
  let other: Customer;
  let now: number;

  beforeEach(async () => {
    await resetDatabase(db);
    now = Math.floor(Date.now() / 1000);
    app = createTestApp({ db, clock: () => now });
    me = await customer(db);
    other = await customer(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function userRow(who: Customer = me) {
    const { rows } = await db.query<{
      first_name: string;
      last_name: string | null;
      birth_date: string | null;
      name_edited: boolean;
      phone: string | null;
      verified_at: Date | null;
      method: string | null;
      updated_at: string;
    }>(
      `SELECT first_name, last_name, to_char(birth_date, 'YYYY-MM-DD') AS birth_date,
              name_edited_at IS NOT NULL AS name_edited, phone, phone_verified_at AS verified_at,
              phone_verification_method AS method, updated_at::text AS updated_at
         FROM users WHERE id = $1::uuid`,
      [who.user.id],
    );
    return rows[0]!;
  }

  function telegramSession(telegramUserId: number, profile: Json) {
    const body = JSON.stringify({ telegram_user_id: telegramUserId, ...profile });
    return call(app, 'POST', SESSION, {
      headers: signedHeaders({
        method: 'POST',
        path: SESSION,
        body,
        actor: `tg:${telegramUserId}`,
        timestamp: now,
        nonce: `nonce-${crypto.randomUUID()}`,
      }),
      entrance: 'public',
      body,
    });
  }

  async function addAddress(who: Customer = me, fields: Json = {}): Promise<Json> {
    const response = await as(app, who).post(ADDRESSES, { ...ADDRESS, ...fields });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as Json;
  }

  async function addresses(who: Customer = me): Promise<Json[]> {
    const response = await as(app, who).get(ADDRESSES);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { items: Json[] }).items;
  }

  // --- PATCH /me ---------------------------------------------------------------------------------

  it('updates only the sent keys (no-store, CSRF)', async () => {
    const response = await as(app, me).patch(ME, { birth_date: '1990-05-17' });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { user } = (await response.json()) as { user: Json };
    expect(Object.keys(user)).toEqual([
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
      'birth_date',
    ]);
    expect(user).toMatchObject({ first_name: 'Test', last_name: null, birth_date: '1990-05-17' });
    expect(await userRow()).toMatchObject({ birth_date: '1990-05-17', name_edited: false });

    const cleared = await as(app, me).patch(ME, { birth_date: null });
    expect(((await cleared.json()) as { user: Json }).user['birth_date']).toBeNull();

    const noCsrf = await call(app, 'PATCH', ME, {
      cookie: me.session.cookie,
      json: { first_name: 'X' },
    });
    expect(noCsrf.status).toBe(403);
    expect((await call(app, 'PATCH', ME, { json: { first_name: 'X' } })).status).toBe(401);
  });

  it('an edited name survives Telegram sign-ins; username is still refreshed', async () => {
    const telegramId = me.user.telegram_user_id;
    const first = await telegramSession(telegramId, { first_name: 'Tg', last_name: 'Name' });
    expect(first.status, await first.clone().text()).toBe(200);
    expect(((await first.json()) as { user: Json }).user).toMatchObject({
      first_name: 'Tg',
      last_name: 'Name',
    });

    const edited = await as(app, me).patch(ME, { first_name: '  Munira ', last_name: 'Karimova' });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect((await userRow()).name_edited).toBe(true);

    const again = await telegramSession(telegramId, {
      first_name: 'Tg',
      last_name: 'Name',
      username: 'new_nick',
    });
    expect(((await again.json()) as { user: Json }).user).toMatchObject({
      first_name: 'Munira',
      last_name: 'Karimova',
      username: 'new_nick',
    });
    // The initData / OIDC sign-in path uses the same upsert.
    const record = await upsertFromTelegram(db, {
      telegramUserId: telegramId,
      firstName: 'Other',
      lastName: 'Person',
      username: 'nick2',
    });
    expect([record.first_name, record.last_name, record.username]).toEqual([
      'Munira',
      'Karimova',
      'nick2',
    ]);

    const cleared = await as(app, me).patch(ME, { last_name: '  ' });
    expect(((await cleared.json()) as { user: Json }).user['last_name']).toBeNull();
  });

  it('keeps a verified number, stores a different one unverified and removes it with null', async () => {
    await recordTelegramPhone(db, me.user.telegram_user_id, '+998901234567');

    const same = await as(app, me).patch(ME, { phone: '90 123-45-67' });
    expect(((await same.json()) as { user: Json }).user).toMatchObject({
      phone_verified: true,
      phone_hint: '+998 •• ••• 45 67',
    });
    expect(await userRow()).toMatchObject({ phone: '+998901234567', method: 'telegram_contact' });

    const different = await as(app, me).patch(ME, { phone: '998 93 765 43 21' });
    const text = await different.text();
    expect(different.status, text).toBe(200);
    expect(text).not.toContain('93765');
    expect(JSON.parse(text).user).toMatchObject({
      phone_verified: false,
      phone_hint: '+998 •• ••• 43 21',
    });
    expect(await userRow()).toMatchObject({
      phone: '+998937654321',
      verified_at: null,
      method: null,
    });

    const removed = await as(app, me).patch(ME, { phone: null });
    expect(((await removed.json()) as { user: Json }).user).toMatchObject({
      phone_verified: false,
      phone_hint: null,
    });
    expect(await userRow()).toMatchObject({ phone: null, verified_at: null, method: null });
  });

  it('refuses invalid bodies and writes nothing', async () => {
    const before = await userRow();
    const cases: [unknown, string[], string][] = [
      [{}, ['body'], 'Value error, at least one field is required'],
      [{ first_name: null }, ['body', 'first_name'], 'Input should be a valid string'],
      [
        { phone: '+7 912 345 67 89' },
        ['body', 'phone'],
        'Value error, phone must be an Uzbekistan number: +998 and 9 digits, or the 9 digits alone',
      ],
      [{ x: 1 }, ['body', 'x'], 'Extra inputs are not permitted'],
    ];
    for (const [body, loc, msg] of cases) {
      const error = await errorOf(await as(app, me).patch(ME, body), 422, 'validation_error');
      expect(error['details']).toEqual([{ loc, msg }]);
    }
    expect((await userRow()).updated_at).toBe(before.updated_at);
  });

  // --- saved addresses ---------------------------------------------------------------------------

  it('creates, lists, replaces and switches the default', async () => {
    expect(await addresses()).toEqual([]);
    const home = await addAddress(me, { label: ' Uy ', apartment: '12' });
    expect(Object.keys(home)).toEqual([
      'id',
      'label',
      'lat',
      'lon',
      'street',
      'house',
      'apartment',
      'entrance',
      'floor',
      'landmark',
      'is_default',
      'created_at',
      'updated_at',
    ]);
    expect(home).toMatchObject({
      lat: 41.311081,
      lon: 69.240562,
      label: 'Uy',
      apartment: '12',
      is_default: true,
    });
    const work = await addAddress(me, { label: 'Ish', is_default: false });
    expect(work['is_default']).toBe(false);
    const gym = await addAddress(me, { label: 'Sport', is_default: true });
    expect(gym['is_default']).toBe(true);

    let listed = await addresses();
    expect(listed.map((a) => a['label'])).toEqual(['Sport', 'Ish', 'Uy']);
    expect(listed.map((a) => a['is_default'])).toEqual([true, false, false]);

    const replaced = await as(app, me).put(`${ADDRESSES}/${String(work['id'])}`, {
      ...ADDRESS,
      street: 'Navoiy',
      label: null,
    });
    expect(replaced.status, await replaced.clone().text()).toBe(200);
    expect(replaced.headers.get('cache-control')).toBe('no-store');
    const body = (await replaced.json()) as Json;
    expect(body).toMatchObject({
      street: 'Navoiy',
      label: null,
      apartment: null,
      is_default: false,
    });
    expect(body['created_at']).toBe(work['created_at']);
    expect(String(body['updated_at']) > String(work['updated_at'])).toBe(true);

    const moved = await as(app, me).put(`${ADDRESSES}/${String(home['id'])}`, {
      ...ADDRESS,
      is_default: true,
    });
    expect(((await moved.json()) as Json)['is_default']).toBe(true);
    listed = await addresses();
    expect(listed.map((a) => a['id'])).toEqual([home['id'], work['id'], gym['id']]);
    expect(listed.filter((a) => a['is_default'])).toHaveLength(1);

    const unset = await as(app, me).put(`${ADDRESSES}/${String(home['id'])}`, {
      ...ADDRESS,
      is_default: false,
    });
    expect(((await unset.json()) as Json)['is_default']).toBe(false);
    expect((await addresses()).some((a) => a['is_default'])).toBe(false);
  });

  it('deleting the default promotes the most recently updated address', async () => {
    const first = await addAddress(me, { label: 'A' });
    const second = await addAddress(me, { label: 'B' });
    const third = await addAddress(me, { label: 'C' });
    await as(app, me).put(`${ADDRESSES}/${String(second['id'])}`, { ...ADDRESS, label: 'B2' });

    const deleted = await as(app, me).delete(`${ADDRESSES}/${String(first['id'])}`);
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');
    expect(deleted.headers.get('cache-control')).toBe('no-store');
    expect((await addresses()).map((a) => [a['label'], a['is_default']])).toEqual([
      ['B2', true],
      ['C', false],
    ]);

    expect((await as(app, me).delete(`${ADDRESSES}/${String(third['id'])}`)).status).toBe(204);
    expect((await addresses()).map((a) => [a['label'], a['is_default']])).toEqual([['B2', true]]);
    expect((await as(app, me).delete(`${ADDRESSES}/${String(second['id'])}`)).status).toBe(204);
    expect(await addresses()).toEqual([]);
  });

  it("another user's address is not found and nothing changes", async () => {
    const mine = await addAddress(me, { label: 'Mine' });
    const theirs = await addAddress(other, { label: 'Theirs' });
    const theirsPath = `${ADDRESSES}/${String(theirs['id'])}`;
    await errorOf(
      await as(app, me).put(theirsPath, { ...ADDRESS, is_default: true }),
      404,
      'address_not_found',
    );
    await errorOf(await as(app, me).delete(theirsPath), 404, 'address_not_found');
    await errorOf(
      await as(app, me).delete(`${ADDRESSES}/${crypto.randomUUID()}`),
      404,
      'address_not_found',
    );
    expect((await addresses()).map((a) => [a['id'], a['is_default']])).toEqual([
      [mine['id'], true],
    ]);
    expect((await addresses(other)).map((a) => [a['label'], a['is_default']])).toEqual([
      ['Theirs', true],
    ]);

    const badId = await errorOf(
      await as(app, me).delete(`${ADDRESSES}/not-a-uuid`),
      422,
      'validation_error',
    );
    expect((badId['details'] as { loc: string[] }[])[0]?.loc).toEqual(['path', 'address_id']);
  });

  it('allows ten addresses per user', async () => {
    for (let index = 0; index < 10; index += 1) await addAddress(me, { label: `A${index}` });
    await errorOf(await as(app, me).post(ADDRESSES, ADDRESS), 409, 'address_limit_reached');
    expect(await addresses()).toHaveLength(10);
    await addAddress(other);
  });

  it('concurrent creates respect the limit and the single default', async () => {
    const responses = await Promise.all(
      Array.from({ length: 14 }, (_, index) =>
        as(app, me).post(ADDRESSES, { ...ADDRESS, label: `C${index}` }),
      ),
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([...Array<number>(10).fill(201), ...Array<number>(4).fill(409)]);
    const { rows } = await db.query<{ is_default: boolean }>(
      'SELECT is_default FROM user_addresses WHERE user_id = $1::uuid',
      [me.user.id],
    );
    expect(rows).toHaveLength(10);
    expect(rows.filter((row) => row.is_default)).toHaveLength(1);
  });

  // --- order history tabs and thumbnails ---------------------------------------------------------

  async function insertOrder(
    status: (typeof ORDER_STATUSES)[number],
    lines: [string | null, string][],
    who: Customer = me,
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO orders (number, user_id, status, subtotal_uzs, total_uzs, item_count,
                           payment_method, recipient_name, recipient_phone, address_snapshot,
                           cancel_reason, idempotency_key, idempotency_request_hash)
       VALUES ('T-' || substr(md5(random()::text), 1, 10), $1::uuid, $2::order_status, $3, $3,
               $4, 'cash_on_delivery', 'Demo Mijoz', '+998001234567',
               '{"lat": 41.3, "lon": 69.2, "street": "Demo", "house": "1"}'::jsonb, $5,
               md5(random()::text), repeat('0', 64))
       RETURNING id::text AS id`,
      [
        who.user.id,
        status,
        1_000 * lines.length,
        lines.length,
        status === 'CANCELLED' ? 'Demo' : null,
      ],
    );
    const orderId = rows[0]!.id;
    for (const [productId, name] of lines) {
      await db.query(
        `INSERT INTO order_items (order_id, product_id, sku, name_uz, name_ru, unit,
                                  unit_price_uzs, quantity, line_total_uzs)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'piece', 1000, 1, 1000)`,
        [orderId, productId, `DEMO-${name}`, name, `ru-${name}`],
      );
    }
    return orderId;
  }

  it('filters the order history by status group in SQL', async () => {
    const category = await addCategory(db, 'profile-cat');
    const product = await addProduct(db, category, 'p-group');
    const byStatus: Record<string, string> = {};
    for (const status of ORDER_STATUSES) {
      byStatus[status] = await insertOrder(status, [[product, 'x']]);
    }
    await insertOrder('NEW', [[product, 'x']], other);

    async function ids(group: string, extra = '') {
      const response = await as(app, me).get(`${ORDERS}?status_group=${group}${extra}`);
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as { items: Json[]; total: number; total_pages: number };
      return [new Set(body.items.map((item) => item['id'])), body.total, body.total_pages];
    }
    const of = (...statuses: string[]) => new Set(statuses.map((status) => byStatus[status]));

    expect(await ids('all')).toEqual([of(...ORDER_STATUSES), 7, 1]);
    expect(await ids('active')).toEqual([
      of('NEW', 'CONFIRMED', 'PICKING', 'READY_FOR_DELIVERY'),
      4,
      1,
    ]);
    expect(await ids('delivering')).toEqual([of('OUT_FOR_DELIVERY'), 1, 1]);
    expect(await ids('done')).toEqual([of('DELIVERED'), 1, 1]);
    expect(await ids('cancelled')).toEqual([of('CANCELLED'), 1, 1]);
    const [pageTwo, total, pages] = await ids('active', '&page=2&page_size=3');
    expect([(pageTwo as Set<string>).size, total, pages]).toEqual([1, 4, 2]);
    const all = (await (await as(app, me).get(ORDERS)).json()) as { total: number };
    expect(all.total).toBe(7);

    const refused = await errorOf(
      await as(app, me).get(`${ORDERS}?status_group=open`),
      422,
      'validation_error',
    );
    expect(refused['details']).toEqual([
      {
        loc: ['query', 'status_group'],
        msg: "Input should be 'all', 'active', 'delivering', 'done' or 'cancelled'",
      },
    ]);
  });

  it('returns up to four thumbnails with current images, in two statements per page', async () => {
    const category = await addCategory(db, 'thumb-cat');
    const withImage = await addProduct(db, category, 'p-img', {
      imageUrl: 'https://img.example.com/a.webp',
    });
    const withoutImage = await addProduct(db, category, 'p-noimg');
    const big = await insertOrder('NEW', [
      [withImage, 'f'],
      [withoutImage, 'b'],
      [null, 'e'],
      [withImage, 'a'],
      [withoutImage, 'd'],
      [withImage, 'c'],
    ]);
    const gone = await insertOrder('DELIVERED', [[null, 'z']]);
    for (let index = 0; index < 3; index += 1) {
      await insertOrder(
        'CONFIRMED',
        Array.from({ length: 5 }, () => [withImage, `n${index}`]),
      );
    }
    await db.query('UPDATE products SET image_url = $2 WHERE id = $1::uuid', [
      withImage,
      'https://img.example.com/new.webp',
    ]);

    const spy = vi.spyOn(db.pool, 'query');
    const response = await as(app, me).get(`${ORDERS}?page_size=50`);
    const orderStatements = spy.mock.calls.filter(([sql]) =>
      /\bFROM orders\b/.test(String(typeof sql === 'string' ? sql : '')),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(orderStatements).toHaveLength(2);

    const items = new Map(
      ((await response.json()) as { items: Json[] }).items.map((item) => [item['id'], item]),
    );
    const thumbnails = items.get(big)!['thumbnails'] as Json[];
    expect(thumbnails.map((thumb) => thumb['name_uz'])).toEqual(['a', 'b', 'c', 'd']);
    expect(thumbnails[0]).toEqual({
      product_id: withImage,
      name_uz: 'a',
      name_ru: 'ru-a',
      image_url: 'https://img.example.com/new.webp',
    });
    expect(Object.keys(thumbnails[0]!)).toEqual(['product_id', 'name_uz', 'name_ru', 'image_url']);
    expect(thumbnails[1]!['image_url']).toBeNull();
    expect(thumbnails[3]!['image_url']).toBeNull();
    const detail = (await (await as(app, me).get(`${ORDERS}/${big}`)).json()) as { items: Json[] };
    expect(detail.items.slice(0, 4).map((line) => line['name_uz'])).toEqual(['a', 'b', 'c', 'd']);

    expect(items.get(gone)!['thumbnails']).toEqual([
      { product_id: null, name_uz: 'z', name_ru: 'ru-z', image_url: null },
    ]);
    for (const item of items.values()) {
      expect((item['thumbnails'] as Json[]).length).toBeLessThanOrEqual(4);
    }
  });
});
