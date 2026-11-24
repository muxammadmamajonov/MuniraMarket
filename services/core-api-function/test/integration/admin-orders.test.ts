/** Back-office orders over HTTP (port of the operator cases in test_orders_{api,integration}.py). */
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
  connectStaffChat,
  customer,
  DEMO_POINT,
  errorOf,
  place,
  stockOf,
  type Customer,
} from './catalog.seed.ts';

const ADMIN = '/api/v1/admin/orders';
type Json = Record<string, unknown>;

describe.skipIf(!hasDatabase)('admin orders', () => {
  const db = testDatabase() as Database;
  const app = createTestApp({ db });
  let me: Customer;
  let operator: { user: { id: string }; session: TestSession };
  let apple: string;

  const staffGet = (path: string, session: TestSession = operator.session) =>
    call(app, 'GET', path, { entrance: 'admin', cookie: session.cookie });
  const move = (orderId: string, body: Json, session: TestSession = operator.session) =>
    call(app, 'PATCH', `${ADMIN}/${orderId}/status`, {
      entrance: 'admin',
      cookie: session.cookie,
      headers: session.writeHeaders,
      json: body,
    });
  const newOrder = async (): Promise<Json & { id: string; number: string }> => {
    await addToCart(app, me, apple, 2);
    return (await place(app, me)) as Json & { id: string; number: string };
  };

  beforeEach(async () => {
    await resetDatabase(db);
    me = await customer(db);
    operator = await createStaff(db, 'operator');
    const category = await addCategory(db, 'admin-cat');
    apple = await addProduct(db, category, 'apple', { price: 30_000, stock: 10 });
  });

  it('moves an order through its lifecycle with history, outbox and staff alerts', async () => {
    await connectStaffChat(db, -100_777);
    const order = await newOrder();
    let body: Json = {};
    for (const status of [
      'CONFIRMED',
      'PICKING',
      'READY_FOR_DELIVERY',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
    ]) {
      const response = await move(order.id, { status });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      body = (await response.json()) as Json;
      expect(body['status']).toBe(status);
    }
    expect(Object.keys(body).slice(-4)).toEqual([
      'history_detail',
      'allowed_transitions',
      'can_adjust_items',
      'adjustments',
    ]);
    expect(body['allowed_transitions']).toEqual([]);
    expect(body['can_adjust_items']).toBe(false);
    expect(body['adjustments']).toEqual([]);
    expect(body['can_cancel']).toBe(false);
    const detail = body['history_detail'] as Json[];
    expect(
      detail.map((h) => [h['from_status'], h['status'], h['actor_role'], h['reason']]),
    ).toEqual([
      [null, 'NEW', 'customer', null],
      ['NEW', 'CONFIRMED', 'operator', null],
      ['CONFIRMED', 'PICKING', 'operator', null],
      ['PICKING', 'READY_FOR_DELIVERY', 'operator', null],
      ['READY_FOR_DELIVERY', 'OUT_FOR_DELIVERY', 'operator', null],
      ['OUT_FOR_DELIVERY', 'DELIVERED', 'operator', null],
    ]);
    expect(Object.keys(detail[0]!)).toEqual([
      'from_status',
      'status',
      'actor_role',
      'reason',
      'at',
    ]);

    const { rows } = await db.query<{ event_type: string; status: string; chat_id: number }>(
      `SELECT event_type, payload->>'status' AS status, (payload->>'chat_id')::int8 AS chat_id
         FROM notification_outbox WHERE order_id = $1 ORDER BY created_at, event_type DESC`,
      [order.id],
    );
    const customerChat = me.user.telegram_user_id;
    expect(rows.map((r) => [r.event_type, r.status, r.chat_id])).toEqual([
      ['order.status_changed', 'NEW', customerChat],
      ['order.staff_alert', 'NEW', -100_777],
      ['order.status_changed', 'CONFIRMED', customerChat],
      ['order.status_changed', 'PICKING', customerChat],
      ['order.status_changed', 'READY_FOR_DELIVERY', customerChat],
      ['order.status_changed', 'OUT_FOR_DELIVERY', customerChat],
      ['order.staff_alert', 'OUT_FOR_DELIVERY', -100_777],
      ['order.status_changed', 'DELIVERED', customerChat],
      ['order.staff_alert', 'DELIVERED', -100_777],
    ]);
    // Only the NEW alert carries the drop-off point (for the Yandex Go courier button) and the
    // order details; every alert names the recipient (the private staff group, ADR 0015).
    const alerts = await db.query<{ status: string; payload: Json }>(
      `SELECT payload->>'status' AS status, payload FROM notification_outbox
        WHERE order_id = $1 AND event_type = 'order.staff_alert' ORDER BY created_at`,
      [order.id],
    );
    expect(alerts.rows.map((r) => [r.status, r.payload['destination'] ?? null])).toEqual([
      ['NEW', DEMO_POINT],
      ['OUT_FOR_DELIVERY', null],
      ['DELIVERED', null],
    ]);
    expect(alerts.rows.map((r) => r.payload['recipient_name'])).toEqual([
      'Demo Mijoz',
      'Demo Mijoz',
      'Demo Mijoz',
    ]);
    expect(alerts.rows.map((r) => 'details' in r.payload)).toEqual([true, false, false]);
    for (const { payload } of alerts.rows.slice(1)) {
      expect(JSON.stringify(payload)).not.toMatch(/Demo ko|\+998/);
    }
    const audits = await db.query<{ actor_role: string; to: string }>(
      `SELECT actor_role::text AS actor_role, details->'changes'->'status'->>'to' AS to
         FROM audit_log WHERE entity_id = $1 ORDER BY created_at`,
      [order.id],
    );
    expect(audits.rows.map((r) => r.to)).toEqual([
      'CONFIRMED',
      'PICKING',
      'READY_FOR_DELIVERY',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
    ]);
    expect(new Set(audits.rows.map((r) => r.actor_role))).toEqual(new Set(['operator']));
  });

  it('refuses invalid transitions and stale expected statuses with current_status', async () => {
    const order = await newOrder();
    const skip = await errorOf(
      await move(order.id, { status: 'PICKING' }),
      409,
      'invalid_status_transition',
    );
    expect(skip['current_status']).toBe('NEW');
    const noReason = await errorOf(
      await move(order.id, { status: 'CANCELLED' }),
      409,
      'invalid_status_transition',
    );
    expect(noReason['current_status']).toBe('NEW');
    const stale = await errorOf(
      await move(order.id, { status: 'PICKING', expected_status: 'CONFIRMED' }),
      409,
      'order_status_conflict',
    );
    expect(stale['current_status']).toBe('NEW');
    expect((await move(order.id, { status: 'CONFIRMED', expected_status: 'NEW' })).status).toBe(
      200,
    );
    // A colleague's change already went through: the same request now conflicts.
    const conflict = await errorOf(
      await move(order.id, { status: 'CONFIRMED', expected_status: 'NEW' }),
      409,
      'order_status_conflict',
    );
    expect(conflict['current_status']).toBe('CONFIRMED');
    await errorOf(await move(crypto.randomUUID(), { status: 'CONFIRMED' }), 404, 'order_not_found');
    await errorOf(await move(order.id, { status: 'SHIPPED' }), 422, 'validation_error');
    await errorOf(
      await move(order.id, { status: 'CANCELLED', reason: '  ' }),
      422,
      'validation_error',
    );
  });

  it('cancels with a reason, restocks once (concurrently too) and alerts staff', async () => {
    await connectStaffChat(db);
    const order = await newOrder();
    expect(await stockOf(db, apple)).toBe(8);
    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        move(order.id, { status: 'CANCELLED', reason: 'Mijoz rad etdi' }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await stockOf(db, apple)).toBe(10);
    const detail = (await (await staffGet(`${ADMIN}/${order.id}`)).json()) as Json;
    expect(detail).toMatchObject({
      status: 'CANCELLED',
      cancel_reason: 'Mijoz rad etdi',
      allowed_transitions: [],
    });
    const alert = await db.query<{ payload: Json }>(
      "SELECT payload FROM notification_outbox WHERE event_type = 'order.staff_alert' AND payload->>'status' = 'CANCELLED'",
    );
    expect(alert.rows).toHaveLength(1);
    expect(alert.rows[0]!.payload).toMatchObject({
      cancelled_by_customer: false,
      previous_status: 'NEW',
    });
  });

  it('lists all orders newest first, filtered by status, and reads any order', async () => {
    const first = await newOrder();
    const second = await newOrder();
    await move(first.id, { status: 'CONFIRMED' });
    const all = (await (await staffGet(ADMIN)).json()) as { items: Json[]; total: number };
    expect(all.total).toBe(2);
    expect(all.items.map((o) => o['id'])).toEqual([second.id, first.id]);
    const confirmed = (await (await staffGet(`${ADMIN}?status=CONFIRMED`)).json()) as {
      items: Json[];
    };
    expect(confirmed.items.map((o) => o['id'])).toEqual([first.id]);
    await errorOf(await staffGet(`${ADMIN}?status=LOST`), 422, 'validation_error');
    const detail = (await (await staffGet(`${ADMIN}/${second.id}`)).json()) as Json;
    expect(detail).toMatchObject({
      id: second.id,
      recipient_name: 'Demo Mijoz',
      allowed_transitions: ['CONFIRMED', 'CANCELLED'],
    });
    await errorOf(await staffGet(`${ADMIN}/${crypto.randomUUID()}`), 404, 'order_not_found');
  });

  it('keeps customers and storefront sessions out of the back office', async () => {
    const order = await newOrder();
    // A storefront session is not a back-office session.
    expect(
      (await call(app, 'GET', ADMIN, { entrance: 'admin', cookie: me.session.cookie })).status,
    ).toBe(403);
    expect((await call(app, 'GET', ADMIN, { entrance: 'admin' })).status).toBe(401);
    // CSRF on the status change.
    const noCsrf = await call(app, 'PATCH', `${ADMIN}/${order.id}/status`, {
      entrance: 'admin',
      cookie: operator.session.cookie,
      json: { status: 'CONFIRMED' },
    });
    await errorOf(noCsrf, 403, 'csrf_failed');
    const { rows } = await db.query<{ status: string }>(
      'SELECT status::text AS status FROM orders WHERE id = $1',
      [order.id],
    );
    expect(rows[0]!.status).toBe('NEW');
  });
});
