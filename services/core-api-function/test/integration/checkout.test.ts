/** Checkout quote over HTTP (port of the quote cases in test_orders_integration.py). */
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
  addCategory,
  addProduct,
  addToCart,
  as,
  customer,
  errorOf,
  type Customer,
} from './catalog.seed.ts';

const QUOTE = '/api/v1/checkout/quote';

describe.skipIf(!hasDatabase)('checkout quote', () => {
  const db = testDatabase() as Database;
  const app = createTestApp({ db });
  let me: Customer;
  let category: string;

  const quote = () => as(app, me).post(QUOTE);

  beforeEach(async () => {
    await resetDatabase(db);
    me = await customer(db);
    category = await addCategory(db, 'q-cat');
  });

  it('totals the cart with no delivery charge, in the reference shape', async () => {
    const apple = await addProduct(db, category, 'apple', { price: 30_000, stock: 5 });
    await addToCart(app, me, apple, 2);
    const response = await quote();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([
      'items',
      'item_count',
      'subtotal_uzs',
      'total_uzs',
      'issues',
      'can_place_order',
    ]);
    expect(body).toMatchObject({
      item_count: 2,
      subtotal_uzs: 60_000,
      total_uzs: 60_000,
      issues: [],
      can_place_order: true,
    });
  });

  it('has no minimum order and reports an empty cart and bad lines as issues', async () => {
    let body = (await (await quote()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      issues: ['cart_empty'],
      can_place_order: false,
      subtotal_uzs: 0,
      total_uzs: 0,
    });
    const small = await addProduct(db, category, 'small', { price: 1_000, stock: null });
    await addToCart(app, me, small, 1);
    body = (await (await quote()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ issues: [], can_place_order: true, total_uzs: 1_000 });
    const scarce = await addProduct(db, category, 'scarce', { price: 5_000, stock: 3 });
    await addToCart(app, me, scarce, 3);
    await db.query('UPDATE products SET stock_quantity = 1 WHERE id = $1', [scarce]);
    body = (await (await quote()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      issues: ['cart_has_issues'],
      can_place_order: false,
      subtotal_uzs: 1_000,
      total_uzs: 1_000,
    });
  });

  it('takes no body: whatever is sent is ignored', async () => {
    const legacy = await as(app, me).post(QUOTE, { area: 'old-client' });
    expect(legacy.status).toBe(200);
    const garbage = await call(app, 'POST', QUOTE, {
      cookie: me.session.cookie,
      headers: { ...me.session.writeHeaders, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(garbage.status).toBe(200);
  });

  it('requires a session and the CSRF token', async () => {
    const anonymous = await as(app, {
      ...me,
      session: { ...me.session, cookie: 'mm_session=nope' },
    }).post(QUOTE);
    await errorOf(anonymous, 401, 'session_required');
    const noCsrf = await as(app, { ...me, session: { ...me.session, writeHeaders: {} } }).post(
      QUOTE,
    );
    await errorOf(noCsrf, 403, 'csrf_failed');
  });
});
