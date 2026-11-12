/**
 * Order creation, idempotency, concurrency, customer reads and cancellation over HTTP against the
 * Alembic schema (port of test_orders_integration.py).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db.ts';
import {
  call,
  createTestApp,
  hasDatabase,
  resetDatabase,
  testDatabase,
} from '../helpers/harness.ts';
import {
  DEMO_PHONE,
  DEMO_POINT,
  addCategory,
  addProduct,
  addToCart,
  as,
  connectStaffChat,
  customer,
  errorOf,
  newKey,
  orderBody,
  place,
  placeOrder,
  quotedTotal,
  stockOf,
  type Customer,
} from './catalog.seed.ts';

const ORDERS = '/api/v1/orders';
const ORDER_NUMBER = /^\d{6}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/;

type Json = Record<string, unknown>;

describe.skipIf(!hasDatabase)('orders', () => {
  const db = testDatabase() as Database;
  const app = createTestApp({ db });
  let me: Customer;
  let category: string;

  const count = async (sql: string, params: unknown[] = []) =>
    Number((await db.query<{ n: number }>(sql, params)).rows[0]!.n);
  const outbox = async (orderId: string) =>
    (
      await db.query<{
        event_type: string;
        payload: Json;
        attempts: number;
        processed_at: Date | null;
      }>(
        'SELECT event_type, payload, attempts, processed_at FROM notification_outbox WHERE order_id = $1 ORDER BY created_at, event_type DESC',
        [orderId],
      )
    ).rows;
  const history = async (orderId: string) =>
    (
      await db.query<{
        from_status: string | null;
        to_status: string;
        actor_role: string;
        actor_user_id: string | null;
        reason: string | null;
      }>(
        `SELECT from_status::text AS from_status, to_status::text AS to_status, actor_role::text AS actor_role,
                actor_user_id::text AS actor_user_id, reason
           FROM order_status_history WHERE order_id = $1 ORDER BY created_at, id`,
        [orderId],
      )
    ).rows;

  beforeEach(async () => {
    await resetDatabase(db);
    me = await customer(db);
    category = await addCategory(db, 'orders-cat');
  });

  it('creates an order: stock, snapshots, cart, history and the outbox row', async () => {
    const tracked = await addProduct(db, category, 'tracked', {
      price: 25_000,
      stock: 10,
      sku: 'DEMO-0100',
    });
    const untracked = await addProduct(db, category, 'untracked', {
      price: 10_000,
      stock: null,
      sku: 'DEMO-0200',
    });
    await addToCart(app, me, tracked, 2);
    await addToCart(app, me, untracked, 3);
    const total = await quotedTotal(app, me);
    expect(total).toBe(80_000);

    const response = await placeOrder(app, me, total, {
      recipient_phone: '+998 00 123-45-67',
      comment: ' Demo izoh ',
      address: {
        lat: 41.31108149,
        lon: '69.240562',
        street: " Demo ko'cha ",
        house: '7',
        floor: '',
      },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('idempotent-replayed')).toBeNull();
    const order = (await response.json()) as Json & { id: string; number: string; items: Json[] };
    expect(Object.keys(order)).toEqual([
      'id',
      'number',
      'status',
      'created_at',
      'updated_at',
      'subtotal_uzs',
      'total_uzs',
      'item_count',
      'payment_method',
      'recipient_name',
      'recipient_phone',
      'address',
      'comment',
      'cancel_reason',
      'items',
      'history',
      'can_cancel',
    ]);
    expect(order.number).toMatch(ORDER_NUMBER);
    expect(order).toMatchObject({
      status: 'NEW',
      subtotal_uzs: 80_000,
      total_uzs: 80_000,
      item_count: 5,
      payment_method: 'cash_on_delivery',
      recipient_phone: DEMO_PHONE,
      comment: 'Demo izoh',
      cancel_reason: null,
      can_cancel: true,
    });
    expect(order['address']).toEqual({
      lat: 41.311081,
      lon: 69.240562,
      street: "Demo ko'cha",
      house: '7',
      apartment: null,
      entrance: null,
      floor: null,
      landmark: null,
    });
    expect(Object.keys(order['address'] as Json)).toEqual([
      'lat',
      'lon',
      'street',
      'house',
      'apartment',
      'entrance',
      'floor',
      'landmark',
    ]);
    expect(order).toMatchObject({
      address: {
        street: "Demo ko'cha",
        house: '7',
        apartment: null,
        entrance: null,
        floor: null,
        landmark: null,
      },
    });
    expect(order['created_at']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{6})?Z$/);
    expect((order['history'] as Json[]).map((h) => h['status'])).toEqual(['NEW']);
    expect(order.items.find((line) => line['sku'] === 'DEMO-0100')).toEqual({
      product_id: tracked,
      sku: 'DEMO-0100',
      name_uz: 'Demo tracked',
      name_ru: 'Демо tracked',
      unit: 'piece',
      unit_price_uzs: 25_000,
      quantity: 2,
      line_total_uzs: 50_000,
    });

    expect(await stockOf(db, tracked)).toBe(8);
    expect(await stockOf(db, untracked)).toBeNull();
    expect(await count('SELECT count(*)::int8 AS n FROM cart_items')).toBe(0);
    const stored = await db.query<{ address: Json; hash: string }>(
      'SELECT address_snapshot AS address, idempotency_request_hash AS hash FROM orders WHERE id = $1',
      [order.id],
    );
    expect(stored.rows[0]!.address).toEqual({
      lat: 41.311081,
      lon: 69.240562,
      street: "Demo ko'cha",
      house: '7',
      apartment: null,
      entrance: null,
      floor: null,
      landmark: null,
    });
    expect(stored.rows[0]!.hash).toHaveLength(64);

    expect(await history(order.id)).toEqual([
      {
        from_status: null,
        to_status: 'NEW',
        actor_role: 'customer',
        actor_user_id: me.user.id,
        reason: null,
      },
    ]);
    const [message, ...rest] = await outbox(order.id);
    expect(rest).toEqual([]); // no staff chat connected: no staff alert
    expect(message).toMatchObject({
      event_type: 'order.status_changed',
      attempts: 0,
      processed_at: null,
    });
    expect(message!.payload).toEqual({
      order_id: order.id,
      order_number: order.number,
      status: 'NEW',
      locale: 'uz',
      total_uzs: 80_000,
      chat_id: me.user.telegram_user_id,
    });
    const serialized = JSON.stringify(message!.payload);
    for (const personal of [
      DEMO_PHONE,
      DEMO_PHONE.slice(4),
      "Demo ko'cha",
      'Demo Mijoz',
      '41.311',
      '69.240',
      'Demo izoh',
    ]) {
      expect(serialized).not.toContain(personal);
    }

    // Snapshots survive catalog changes; reading it back gives the same body.
    await db.query("UPDATE products SET price_uzs = 99000, name_uz = 'Demo yangi' WHERE id = $1", [
      tracked,
    ]);
    const again = (await (await as(app, me).get(`${ORDERS}/${order.id}`)).json()) as Json;
    expect(again).toEqual(order);
  });

  it('replays the same key and body, refuses the key with another body', async () => {
    const apple = await addProduct(db, category, 'apple', { price: 30_000, stock: 5 });
    await addToCart(app, me, apple, 2);
    const total = await quotedTotal(app, me);
    const key = newKey();
    const first = await placeOrder(app, me, total, {}, key);
    expect(first.status).toBe(201);
    const created = (await first.json()) as Json;

    // Cosmetic differences hash the same (validated, normalised body), coordinate digits beyond
    // the sixth decimal included.
    const replay = await placeOrder(
      app,
      me,
      total,
      {
        recipient_phone: '+998 00 123 45 67',
        recipient_name: ' Demo Mijoz ',
        address: {
          lat: DEMO_POINT.lat + 1e-8,
          lon: String(DEMO_POINT.lon),
          street: " Demo ko'cha ",
          house: '12',
        },
      },
      key,
    );
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(await replay.json()).toEqual(created);
    expect(await stockOf(db, apple)).toBe(3);

    await errorOf(await placeOrder(app, me, total + 1, {}, key), 409, 'idempotency_key_conflict');
    const moved = {
      ...DEMO_POINT,
      lat: DEMO_POINT.lat + 0.001,
      street: "Demo ko'cha",
      house: '12',
    };
    await errorOf(
      await placeOrder(app, me, total, { address: moved }, key),
      409,
      'idempotency_key_conflict',
    );
    expect(await count('SELECT count(*)::int8 AS n FROM orders')).toBe(1);
  });

  it('validates the Idempotency-Key header and the body after the session checks', async () => {
    for (const key of [
      '',
      'short',
      'x'.repeat(129),
      'test idempotency key 0002',
      'test.idempotency.key.0004',
    ]) {
      const response = await as(app, me).post(ORDERS, orderBody(), { 'idempotency-key': key });
      const error = await errorOf(response, 422, 'validation_error');
      expect((error['details'] as { loc: string[] }[])[0]!.loc).toEqual([
        'header',
        'Idempotency-Key',
      ]);
    }
    const missing = await as(app, me).post(ORDERS, orderBody());
    await errorOf(missing, 422, 'validation_error');
    const bad = await as(app, me).post(ORDERS, orderBody({ recipient_phone: '998001234567' }), {
      'idempotency-key': newKey(),
    });
    const text = await bad.clone().text();
    await errorOf(bad, 422, 'validation_error');
    expect(text).not.toContain('998001234567');
    // No CSRF token: 403 before the body or header is looked at.
    const noCsrf = await call(app, 'POST', ORDERS, { cookie: me.session.cookie, json: {} });
    await errorOf(noCsrf, 403, 'csrf_failed');
  });

  it('concurrent requests with one key create one order', async () => {
    const apple = await addProduct(db, category, 'apple', { price: 30_000, stock: 50 });
    await addToCart(app, me, apple, 2);
    const total = await quotedTotal(app, me);
    const key = newKey();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => placeOrder(app, me, total, {}, key)),
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 201]);
    const ids = new Set(
      await Promise.all(responses.map(async (r) => ((await r.json()) as Json)['id'])),
    );
    expect(ids.size).toBe(1);
    expect(await count('SELECT count(*)::int8 AS n FROM orders')).toBe(1);
    expect(await stockOf(db, apple)).toBe(48);
  });

  it('parallel orders for the last units never oversell', async () => {
    const STOCK = 3;
    const BUYERS = 8;
    const scarce = await addProduct(db, category, 'scarce', { price: 60_000, stock: STOCK });
    const buyers = await Promise.all(Array.from({ length: BUYERS }, () => customer(db)));
    for (const buyer of buyers) await addToCart(app, buyer, scarce, 1);
    const totals = await Promise.all(buyers.map((buyer) => quotedTotal(app, buyer)));
    const responses = await Promise.all(
      buyers.map((buyer, i) => placeOrder(app, buyer, totals[i]!)),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(STOCK);
    expect(statuses.filter((s) => s === 409)).toHaveLength(BUYERS - STOCK);
    for (const response of responses.filter((r) => r.status === 409)) {
      const error = await errorOf(response, 409, 'insufficient_stock');
      expect(error).toMatchObject({ product_id: scarce, available_quantity: 0 });
    }
    expect(await stockOf(db, scarce)).toBe(0);
    expect(await count('SELECT count(*)::int8 AS n FROM orders')).toBe(STOCK);
  });

  it('parallel orders of overlapping carts do not deadlock', async () => {
    const a = await addProduct(db, category, 'a', { price: 30_000, stock: 100 });
    const b = await addProduct(db, category, 'b', { price: 30_000, stock: 100 });
    const buyers = await Promise.all(Array.from({ length: 6 }, () => customer(db)));
    for (const [i, buyer] of buyers.entries()) {
      await addToCart(app, buyer, i % 2 === 0 ? a : b, 1);
      await addToCart(app, buyer, i % 2 === 0 ? b : a, 1);
    }
    const totals = await Promise.all(buyers.map((buyer) => quotedTotal(app, buyer)));
    const responses = await Promise.all(
      buyers.map((buyer, i) => placeOrder(app, buyer, totals[i]!)),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(6).fill(201));
    expect([await stockOf(db, a), await stockOf(db, b)]).toEqual([94, 94]);
  });

  it('refuses price changes, inactive products and short stock, leaving nothing behind', async () => {
    const apple = await addProduct(db, category, 'apple', { price: 30_000, stock: 5 });
    await addToCart(app, me, apple, 2);
    const total = await quotedTotal(app, me);
    await db.query('UPDATE products SET price_uzs = 35000 WHERE id = $1', [apple]);
    const changed = await errorOf(await placeOrder(app, me, total), 409, 'price_changed');
    expect(changed['total_uzs']).toBe(70_000);

    await db.query('UPDATE products SET stock_quantity = 1 WHERE id = $1', [apple]);
    const short = await errorOf(await placeOrder(app, me, 70_000), 409, 'insufficient_stock');
    expect(short).toMatchObject({ product_id: apple, available_quantity: 1 });

    await db.query('UPDATE products SET is_active = false WHERE id = $1', [apple]);
    const inactive = await errorOf(await placeOrder(app, me, 70_000), 409, 'product_inactive');
    expect(inactive['product_id']).toBe(apple);

    expect(await count('SELECT count(*)::int8 AS n FROM orders')).toBe(0);
    expect(await count('SELECT count(*)::int8 AS n FROM notification_outbox')).toBe(0);
    expect(await count('SELECT count(*)::int8 AS n FROM cart_items')).toBe(1);
  });

  it('refuses an empty cart and caps open orders; no zone, minimum or hours', async () => {
    await errorOf(await placeOrder(app, me, 0), 409, 'cart_empty');
    const apple = await addProduct(db, category, 'apple', { price: 1_000, stock: null });
    await addToCart(app, me, apple, 1);
    // Anywhere on the map, any amount: delivery is a Yandex Go courier on demand.
    const far = await placeOrder(app, me, 1_000, {
      address: { lat: -33.8688, lon: 151.2093, street: 'Demo', house: '1' },
    });
    expect(far.status, await far.clone().text()).toBe(201);
    for (let i = 0; i < 4; i += 1) {
      await addToCart(app, me, apple, 1);
      await place(app, me);
    }
    await addToCart(app, me, apple, 1);
    await errorOf(await placeOrder(app, me, 1_000), 409, 'too_many_open_orders');
  });

  it('validates the address: coordinates required and in range, no unknown keys', async () => {
    const apple = await addProduct(db, category, 'apple', { price: 50_000, stock: null });
    await addToCart(app, me, apple, 1);
    const invalid = async (address: Json, loc: string[]) => {
      const error = await errorOf(
        await placeOrder(app, me, 50_000, { address }),
        422,
        'validation_error',
      );
      expect((error['details'] as { loc: string[] }[]).map((d) => d.loc)).toEqual([loc]);
    };
    const base = { street: 'Demo', house: '1' };
    await invalid({ ...base, lon: DEMO_POINT.lon }, ['body', 'address', 'lat']);
    await invalid({ ...base, lat: DEMO_POINT.lat }, ['body', 'address', 'lon']);
    await invalid({ ...base, ...DEMO_POINT, lat: 90.5 }, ['body', 'address', 'lat']);
    await invalid({ ...base, ...DEMO_POINT, lon: -181 }, ['body', 'address', 'lon']);
    await invalid({ ...base, ...DEMO_POINT, lat: 'north' }, ['body', 'address', 'lat']);
    await invalid({ ...base, ...DEMO_POINT, area: 'old-client' }, ['body', 'address', 'area']);
    expect(await count('SELECT count(*)::int8 AS n FROM orders')).toBe(0);
  });

  it('reads an order placed before courier delivery (no coordinates, fee kept in the total)', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO orders (id, number, user_id, status, subtotal_uzs, total_uzs, payment_method,
                           recipient_name, recipient_phone, address_snapshot, idempotency_key,
                           idempotency_request_hash, item_count)
       VALUES (gen_random_uuid(), '261001-ABCDEF', $1, 'DELIVERED', 60000, 75000,
               'cash_on_delivery', 'Demo Mijoz', $2, $3::jsonb, 'legacy-key-0000001', $4, 1)
       RETURNING id::text AS id`,
      [
        me.user.id,
        DEMO_PHONE,
        JSON.stringify({
          area: 'old-client',
          street: "Demo ko'cha",
          house: '12',
          apartment: null,
          entrance: null,
          floor: '3',
          landmark: null,
        }),
        'a'.repeat(64),
      ],
    );
    const order = (await (await as(app, me).get(`${ORDERS}/${rows[0]!.id}`)).json()) as Json;
    expect(order).toMatchObject({ subtotal_uzs: 60_000, total_uzs: 75_000 });
    expect(order['address']).toEqual({
      lat: null,
      lon: null,
      street: "Demo ko'cha",
      house: '12',
      apartment: null,
      entrance: null,
      floor: '3',
      landmark: null,
    });
  });

  it('cancels while NEW or CONFIRMED: restocks, writes history, outbox and staff alert', async () => {
    await connectStaffChat(db, -100_500);
    const apple = await addProduct(db, category, 'apple', { price: 30_000, stock: 5 });
    await addToCart(app, me, apple, 2);
    const order = await place(app, me);
    expect(await stockOf(db, apple)).toBe(3);
    const staffNew = (await outbox(order.id)).find((m) => m.event_type === 'order.staff_alert');
    // The drop-off point travels only with the NEW alert (for the Yandex Go courier button).
    expect(staffNew?.payload).toEqual({
      order_id: order.id,
      order_number: order['number'],
      status: 'NEW',
      previous_status: null,
      total_uzs: 60_000,
      chat_id: -100_500,
      cancelled_by_customer: false,
      destination: DEMO_POINT,
    });

    await errorOf(
      await as(app, me).post(`${ORDERS}/${order.id}/cancel`, { reason: ' a ' }),
      422,
      'validation_error',
    );
    const response = await as(app, me).post(`${ORDERS}/${order.id}/cancel`, {
      reason: "  Fikrim o'zgardi ",
    });
    expect(response.status).toBe(200);
    const cancelled = (await response.json()) as Json;
    expect(cancelled).toMatchObject({
      status: 'CANCELLED',
      cancel_reason: "Fikrim o'zgardi",
      can_cancel: false,
    });
    expect((cancelled['history'] as Json[]).map((h) => h['status'])).toEqual(['NEW', 'CANCELLED']);
    expect(await stockOf(db, apple)).toBe(5);
    expect((await history(order.id)).at(-1)).toEqual({
      from_status: 'NEW',
      to_status: 'CANCELLED',
      actor_role: 'customer',
      actor_user_id: me.user.id,
      reason: "Fikrim o'zgardi",
    });
    const messages = await outbox(order.id);
    expect(messages.map((m) => [m.event_type, m.payload['status']])).toEqual([
      ['order.status_changed', 'NEW'],
      ['order.staff_alert', 'NEW'],
      ['order.status_changed', 'CANCELLED'],
      ['order.staff_alert', 'CANCELLED'],
    ]);
    expect(messages[2]!.payload['cancel_reason']).toBe("Fikrim o'zgardi");
    expect(messages[3]!.payload).toMatchObject({
      previous_status: 'NEW',
      cancelled_by_customer: true,
      chat_id: -100_500,
    });
    expect(messages[3]!.payload['cancel_reason']).toBeUndefined();
    expect(messages[3]!.payload['destination']).toBeUndefined();

    const audit = await db.query<{ details: Json; actor_role: string }>(
      "SELECT details, actor_role::text AS actor_role FROM audit_log WHERE action = 'order.status_change'",
    );
    expect(audit.rows).toEqual([
      {
        actor_role: 'customer',
        details: {
          changes: { status: { from: 'NEW', to: 'CANCELLED' } },
          order_number: order['number'],
          has_reason: true,
        },
      },
    ]);

    const again = await errorOf(
      await as(app, me).post(`${ORDERS}/${order.id}/cancel`, { reason: 'Yana bir bor' }),
      409,
      'order_not_cancellable',
    );
    expect(again['current_status']).toBe('CANCELLED');
    expect(await stockOf(db, apple)).toBe(5);
  });

  it('refuses a customer cancel once picking', async () => {
    const apple = await addProduct(db, category, 'apple', { price: 60_000, stock: 5 });
    await addToCart(app, me, apple, 1);
    const order = await place(app, me);
    await db.query("UPDATE orders SET status = 'PICKING' WHERE id = $1", [order.id]);
    const error = await errorOf(
      await as(app, me).post(`${ORDERS}/${order.id}/cancel`, { reason: "Fikrim o'zgardi" }),
      409,
      'order_not_cancellable',
    );
    expect(error['current_status']).toBe('PICKING');
  });

  it("hides other customers' orders (404 order_not_found on read and cancel)", async () => {
    const apple = await addProduct(db, category, 'apple', { price: 60_000, stock: 5 });
    await addToCart(app, me, apple, 1);
    const order = await place(app, me);
    const other = await customer(db);
    await errorOf(await as(app, other).get(`${ORDERS}/${order.id}`), 404, 'order_not_found');
    await errorOf(
      await as(app, other).post(`${ORDERS}/${order.id}/cancel`, { reason: "Fikrim o'zgardi" }),
      404,
      'order_not_found',
    );
    await errorOf(
      await as(app, me).get(`${ORDERS}/${crypto.randomUUID()}`),
      404,
      'order_not_found',
    );
    expect(((await (await as(app, other).get(ORDERS)).json()) as Json)['total']).toBe(0);
    expect((await (await as(app, me).get(`${ORDERS}/${order.id}`)).json()) as Json).toMatchObject({
      status: 'NEW',
    });
    await errorOf(await as(app, me).get(`${ORDERS}/not-a-uuid`), 422, 'validation_error');
    await errorOf(await call(app, 'GET', `${ORDERS}/${order.id}`), 401, 'session_required');
  });

  it('lists the customer orders newest first, paginated', async () => {
    const apple = await addProduct(db, category, 'apple', { price: 60_000, stock: null });
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      await addToCart(app, me, apple, 1);
      ids.push((await place(app, me)).id);
    }
    const page = (await (await as(app, me).get(`${ORDERS}?page_size=2`)).json()) as Json & {
      items: Json[];
    };
    expect(page).toMatchObject({ page: 1, page_size: 2, total: 3, total_pages: 2 });
    expect(page.items.map((o) => o['id'])).toEqual([ids[2], ids[1]]);
    expect(Object.keys(page.items[0]!)).toEqual([
      'id',
      'number',
      'status',
      'total_uzs',
      'item_count',
      'created_at',
    ]);
    const second = (await (await as(app, me).get(`${ORDERS}?page=2&page_size=2`)).json()) as {
      items: Json[];
    };
    expect(second.items.map((o) => o['id'])).toEqual([ids[0]]);
    await errorOf(await as(app, me).get(`${ORDERS}?page_size=51`), 422, 'validation_error');
  });
});
