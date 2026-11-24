/**
 * Safety stock and order-line shortage adjustments over HTTP (ADR 0018; port of the shortage and
 * safety-stock cases in services/api/tests/test_orders_integration.py).
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
import { createStaff, type TestSession } from '../helpers/fixtures.ts';
import {
  addCategory,
  addProduct,
  addToCart,
  as,
  connectStaffChat,
  customer,
  errorOf,
  place,
  placeOrder,
  stockOf,
  type Customer,
} from './catalog.seed.ts';

const ADMIN = '/api/v1/admin/orders';
type Json = Record<string, unknown>;

describe.skipIf(!hasDatabase)('stock shortages (ADR 0018)', () => {
  const db = testDatabase() as Database;
  const app = createTestApp({ db });
  let me: Customer;
  let operator: { user: { id: string }; session: TestSession };
  let category: string;

  const staff = (method: string, path: string, json?: Json) =>
    call(app, method, path, {
      entrance: 'admin',
      cookie: operator.session.cookie,
      headers: operator.session.writeHeaders,
      ...(json === undefined ? {} : { json }),
    });
  const adjust = (orderId: string, productId: string, quantity: number, extra: Json = {}) =>
    staff('PATCH', `${ADMIN}/${orderId}/items/${productId}`, {
      quantity,
      reason: 'Javonda qolmadi',
      ...extra,
    });
  const move = (orderId: string, status: string) =>
    staff('PATCH', `${ADMIN}/${orderId}/status`, { status });
  const outbox = async (orderId: string) =>
    (
      await db.query<{ event_type: string; payload: Json }>(
        `SELECT event_type, payload FROM notification_outbox WHERE order_id = $1
          ORDER BY created_at, id`,
        [orderId],
      )
    ).rows;
  const setSafety = (productId: string, safety: number) =>
    db.query('UPDATE products SET safety_stock = $2 WHERE id = $1', [productId, safety]);

  beforeEach(async () => {
    await resetDatabase(db);
    me = await customer(db);
    operator = await createStaff(db, 'operator');
    category = await addCategory(db, 'shortage-cat');
  });

  it('sells only what is left above the safety stock', async () => {
    const apple = await addProduct(db, category, 'apple', { price: 10_000, stock: 3 });
    await setSafety(apple, 2);
    const listed = (await (await as(app, me).get('/api/v1/products/apple')).json()) as Json;
    expect([listed['stock_quantity'], listed['in_stock'], listed['low_stock']]).toEqual([
      1,
      true,
      true,
    ]);
    const tooMany = await errorOf(
      await as(app, me).post('/api/v1/cart/items', { product_id: apple, quantity: 2 }),
      409,
      'insufficient_stock',
    );
    expect(tooMany['available_quantity']).toBe(1);
    await addToCart(app, me, apple, 1);

    await setSafety(apple, 3);
    const quote = (await (await as(app, me).post('/api/v1/checkout/quote')).json()) as {
      items: Json[];
    };
    expect(quote.items[0]!['issue']).toBe('insufficient_stock');
    const refused = await errorOf(await placeOrder(app, me, 10_000), 409, 'insufficient_stock');
    expect(refused['available_quantity']).toBe(0);

    await setSafety(apple, 2);
    await place(app, me);
    expect(await stockOf(db, apple)).toBe(2); // the physical stock; 2 kept back on the shelf
    const soldOut = (await (await as(app, me).get('/api/v1/products/apple')).json()) as Json;
    expect([soldOut['stock_quantity'], soldOut['in_stock']]).toEqual([0, false]);
    const inStock = (await (await as(app, me).get('/api/v1/products?in_stock=true')).json()) as {
      items: Json[];
    };
    expect(inStock.items.map((item) => item['slug'])).not.toContain('apple');
  });

  it('lowers a line, returns stock and tells the customer and the staff group', async () => {
    await connectStaffChat(db, -100_900);
    const apple = await addProduct(db, category, 'apple', { price: 15_000, stock: 5 });
    const bread = await addProduct(db, category, 'bread', { price: 4_000, stock: null });
    await addToCart(app, me, apple, 3);
    await addToCart(app, me, bread, 2);
    const order = await place(app, me);
    expect(await stockOf(db, apple)).toBe(2);

    const response = await adjust(order.id, apple, 1, { reason: 'Ikkitasi ezilgan' });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as Json & { items: Json[]; adjustments: Json[] };
    expect([body['subtotal_uzs'], body['total_uzs'], body['item_count']]).toEqual([
      23_000, 23_000, 3,
    ]);
    const line = body.items.find((item) => item['product_id'] === apple)!;
    expect([line['quantity'], line['original_quantity'], line['adjusted']]).toEqual([1, 3, true]);
    expect(line['line_total_uzs']).toBe(15_000);
    expect(body['can_adjust_items']).toBe(true);
    expect(body.adjustments).toEqual([
      {
        product_id: apple,
        sku: expect.any(String),
        name_uz: 'Demo apple',
        name_ru: 'Демо apple',
        unit: 'piece',
        from_quantity: 3,
        to_quantity: 1,
        reason: 'Ikkitasi ezilgan',
        marked_out_of_stock: false,
        actor_role: 'operator',
        at: expect.any(String),
      },
    ]);
    expect(await stockOf(db, apple)).toBe(4);
    expect(body['status']).toBe('NEW');

    const events = await outbox(order.id);
    const adjusted = events.filter((e) => e.event_type === 'order.adjusted');
    expect(adjusted.map((e) => e.payload)).toEqual([
      {
        order_id: order.id,
        order_number: order['number'],
        status: 'NEW',
        locale: 'uz',
        total_uzs: 23_000,
        chat_id: me.user.telegram_user_id,
        changes: [
          {
            name_uz: 'Demo apple',
            name_ru: 'Демо apple',
            unit: 'piece',
            from_quantity: 3,
            to_quantity: 1,
          },
        ],
      },
    ]);
    const staffAlert = events.find((e) => e.event_type === 'order.staff_adjusted')!;
    expect(staffAlert.payload).toMatchObject({
      chat_id: -100_900,
      recipient_name: 'Demo Mijoz',
      reason: 'Ikkitasi ezilgan',
      total_uzs: 23_000,
    });

    const audit = await db.query<{ details: Json }>(
      "SELECT details FROM audit_log WHERE action = 'order.item_adjust'",
    );
    expect(audit.rows.map((r) => r.details)).toEqual([
      {
        changes: { quantity: { from: 3, to: 1 } },
        order_number: order['number'],
        sku: expect.any(String),
        marked_out_of_stock: false,
        has_reason: true,
      },
    ]);

    // Retrying the same request (twice, concurrently) changes nothing.
    const retries = await Promise.all([adjust(order.id, apple, 1), adjust(order.id, apple, 1)]);
    expect(retries.map((r) => r.status)).toEqual([200, 200]);
    expect(await stockOf(db, apple)).toBe(4);
    expect((await outbox(order.id)).length).toBe(events.length);
  });

  it('marks the product out of stock and cancels an order whose every line ran out', async () => {
    await connectStaffChat(db);
    const apple = await addProduct(db, category, 'apple', { price: 15_000, stock: 5 });
    await addToCart(app, me, apple, 2);
    const order = await place(app, me);
    expect((await move(order.id, 'CONFIRMED')).status).toBe(200);

    const response = await adjust(order.id, apple, 0, { mark_out_of_stock: true });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as Json;
    expect(body).toMatchObject({
      status: 'CANCELLED',
      cancel_reason: 'Mahsulotlar tugab qoldi',
      subtotal_uzs: 0,
      total_uzs: 0,
      item_count: 0,
      can_adjust_items: false,
    });
    // The goods ran out: the product is out of stock and nothing came back.
    expect(await stockOf(db, apple)).toBe(0);
    const kinds = (await outbox(order.id)).map((e) => [e.event_type, e.payload['status']]);
    expect(kinds).toContainEqual(['order.status_changed', 'CANCELLED']);
    expect(kinds).toContainEqual(['order.staff_alert', 'CANCELLED']);
    expect(kinds.map(([kind]) => kind)).not.toContain('order.adjusted');
    const productAudit = await db.query<{ details: Json }>(
      "SELECT details FROM audit_log WHERE action = 'product.update' AND entity_id = $1",
      [apple],
    );
    expect(productAudit.rows.map((r) => r.details)).toEqual([
      {
        changes: { stock_quantity: { from: 3, to: 0 } },
        source: 'order_adjustment',
        sku: expect.any(String),
        order_number: order['number'],
      },
    ]);
  });

  it('refuses what cannot be adjusted', async () => {
    const apple = await addProduct(db, category, 'apple', { price: 15_000, stock: 5 });
    const pear = await addProduct(db, category, 'pear', { price: 9_000, stock: 5 });
    await addToCart(app, me, apple, 2);
    const order = await place(app, me);

    const tooMany = await errorOf(await adjust(order.id, apple, 3), 409, 'invalid_quantity');
    expect(tooMany['available_quantity']).toBe(2);
    await errorOf(await adjust(order.id, pear, 0), 404, 'order_item_not_found');
    await errorOf(await adjust(crypto.randomUUID(), apple, 0), 404, 'order_not_found');
    await errorOf(await adjust(order.id, apple, 1, { reason: 'x' }), 422, 'validation_error');
    await errorOf(await adjust(order.id, apple, -1), 422, 'validation_error');
    await errorOf(
      await adjust(order.id, apple, 1, { mark_out_of_stock: null }),
      422,
      'validation_error',
    );
    const asCustomer = await call(app, 'PATCH', `${ADMIN}/${order.id}/items/${apple}`, {
      entrance: 'admin',
      cookie: me.session.cookie,
      headers: me.session.writeHeaders,
      json: { quantity: 1, reason: 'Javonda qolmadi' },
    });
    expect(asCustomer.status).toBe(403);

    for (const status of ['CONFIRMED', 'PICKING', 'READY_FOR_DELIVERY']) {
      expect((await move(order.id, status)).status).toBe(200);
    }
    const late = await errorOf(await adjust(order.id, apple, 1), 409, 'order_not_adjustable');
    expect(late['current_status']).toBe('READY_FOR_DELIVERY');
    expect(await stockOf(db, apple)).toBe(3);
  });

  it('lets the customer cancel an adjusted order while it is picked', async () => {
    const apple = await addProduct(db, category, 'apple', { price: 15_000, stock: 5 });
    const bread = await addProduct(db, category, 'bread', { price: 4_000, stock: 5 });
    await addToCart(app, me, apple, 2);
    await addToCart(app, me, bread, 1);
    const order = await place(app, me);
    for (const status of ['CONFIRMED', 'PICKING']) {
      expect((await move(order.id, status)).status).toBe(200);
    }
    const before = (await (await as(app, me).get(`/api/v1/orders/${order.id}`)).json()) as Json;
    expect(before['can_cancel']).toBe(false);
    expect((await adjust(order.id, apple, 1)).status).toBe(200);
    const after = (await (await as(app, me).get(`/api/v1/orders/${order.id}`)).json()) as Json;
    expect(after['can_cancel']).toBe(true);
    const cancelled = await as(app, me).post(`/api/v1/orders/${order.id}/cancel`, {
      reason: 'Kerak emas',
    });
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    expect([await stockOf(db, apple), await stockOf(db, bread)]).toEqual([5, 5]);
  });
});
