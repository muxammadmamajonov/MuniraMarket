/** Back-office dashboard over HTTP (port of test_dashboard_integration.py). */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db.ts';
import { DashboardRepository, tashkentDayBounds } from '../../src/repositories/dashboard.ts';
import { createTestApp, hasDatabase, resetDatabase, testDatabase } from '../helpers/harness.ts';
import {
  addOrder,
  adminCall,
  customer,
  errorOf,
  jsonOf,
  staff,
  type Actor,
} from './admin-helpers.ts';

const DASHBOARD = '/api/v1/admin/dashboard';
// 2026-11-01 00:00 in Tashkent is 2026-10-31 19:00 UTC; "now" is 12:00 local.
const LOCAL_MIDNIGHT = Date.parse('2026-10-31T19:00:00Z');
const NOW = LOCAL_MIDNIGHT + 12 * 3600_000;
const MINUTE = 60_000;

describe('tashkentDayBounds', () => {
  it('local day and its [start, end) instants', () => {
    const [day, start, end] = tashkentDayBounds(NOW / 1000);
    expect(day).toBe('2026-11-01');
    expect([start, end]).toEqual([LOCAL_MIDNIGHT / 1000, LOCAL_MIDNIGHT / 1000 + 86_400]);
    expect(tashkentDayBounds(LOCAL_MIDNIGHT / 1000 - 1)[0]).toBe('2026-10-31');
  });
});

describe.skipIf(!hasDatabase)('admin dashboard', () => {
  const db = testDatabase() as Database;
  let now = NOW;
  const app = createTestApp({ db, clock: () => now / 1000 });
  let operator: Actor;
  let buyer: Actor;

  async function order(createdAt: number, total: number, status = 'NEW', cancelledAt?: number) {
    const id = await addOrder(db, buyer.user.id, { total, status, createdAt: new Date(createdAt) });
    await db.query(
      `INSERT INTO order_status_history (order_id, from_status, to_status, actor_role, created_at)
       VALUES ($1, NULL, 'NEW', 'customer', $2)`,
      [id, new Date(createdAt)],
    );
    if (cancelledAt !== undefined) {
      await db.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, actor_role, reason, created_at)
         VALUES ($1, 'NEW', 'CANCELLED', 'operator', 'Demo sabab', $2)`,
        [id, new Date(cancelledAt)],
      );
    }
  }

  beforeEach(async () => {
    await resetDatabase(db);
    now = NOW;
    operator = await staff(db, 'operator');
    buyer = await customer(db);
  });

  it('an empty dashboard', async () => {
    const response = await adminCall(app, operator, 'GET', DASHBOARD);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await jsonOf(response)).toEqual({
      date: '2026-11-01',
      timezone: 'Asia/Tashkent',
      orders_today: 0,
      new_orders: 0,
      gmv_today_uzs: 0,
      average_order_value_uzs: 0,
      cancelled_today: 0,
    });
  });

  it('figures around local midnight', async () => {
    await order(LOCAL_MIDNIGHT, 100_000);
    await order(LOCAL_MIDNIGHT - 1000, 50_000);
    await order(LOCAL_MIDNIGHT + 10 * MINUTE, 33_333, 'CONFIRMED');
    await order(LOCAL_MIDNIGHT + 20 * MINUTE, 70_000, 'CANCELLED', LOCAL_MIDNIGHT + 25 * MINUTE);
    await order(
      LOCAL_MIDNIGHT - 9 * 60 * MINUTE,
      80_000,
      'CANCELLED',
      LOCAL_MIDNIGHT - 60 * MINUTE,
    );
    await order(LOCAL_MIDNIGHT - 7 * 60 * MINUTE, 90_000, 'CANCELLED', LOCAL_MIDNIGHT + 5 * MINUTE);
    await order(LOCAL_MIDNIGHT + 24 * 60 * MINUTE, 10_000);

    expect(await jsonOf(adminCall(app, operator, 'GET', DASHBOARD))).toEqual({
      date: '2026-11-01',
      timezone: 'Asia/Tashkent',
      orders_today: 3,
      new_orders: 3,
      gmv_today_uzs: 133_333,
      average_order_value_uzs: 66_667,
      cancelled_today: 2,
    });

    now = LOCAL_MIDNIGHT - 1000;
    const admin = await staff(db, 'admin');
    const yesterday = await jsonOf(adminCall(app, admin, 'GET', DASHBOARD));
    expect(yesterday).toMatchObject({
      date: '2026-10-31',
      orders_today: 3,
      gmv_today_uzs: 50_000,
      average_order_value_uzs: 50_000,
      cancelled_today: 1,
      new_orders: 3,
    });
  });

  it('the average rounds half up', async () => {
    const repo = new DashboardRepository(db);
    const summary = async () => {
      const record = await repo.summary(NOW / 1000);
      return [record.gmv_today_uzs, record.average_order_value_uzs];
    };
    for (const total of [10_000, 10_001, 10_001]) await order(NOW, total);
    expect(await summary()).toEqual([30_002, 10_001]);
    await order(NOW, 9_998);
    expect(await summary()).toEqual([40_000, 10_000]);
    await order(NOW, 1);
    expect(await summary()).toEqual([40_001, 8_000]);
    await resetDatabase(db);
    buyer = await customer(db);
    for (const total of [1, 2]) await order(NOW, total);
    expect(await summary()).toEqual([3, 2]);
  });

  it('only staff see the dashboard', async () => {
    expect((await adminCall(app, await staff(db, 'admin'), 'GET', DASHBOARD)).status).toBe(200);
    const response = await adminCall(app, buyer, 'GET', DASHBOARD);
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toEqual({
      code: 'forbidden',
      message: 'Operator role required',
    });
  });
});
