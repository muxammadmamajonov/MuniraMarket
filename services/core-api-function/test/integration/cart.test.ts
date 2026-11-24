/** The signed-in cart over HTTP (port of test_cart_{api,integration}.py). */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db.ts';
import {
  call,
  createTestApp,
  hasDatabase,
  resetDatabase,
  testDatabase,
} from '../helpers/harness.ts';
import { addCategory, addProduct, as, customer, errorOf, type Customer } from './catalog.seed.ts';

const CART = '/api/v1/cart';
const ITEMS = '/api/v1/cart/items';

interface CartBody {
  items: {
    product: { id: string; slug: string };
    quantity: number;
    line_total_uzs: number;
    issue: string | null;
  }[];
  item_count: number;
  subtotal_uzs: number;
  total_uzs: number;
  has_issues: boolean;
}

describe.skipIf(!hasDatabase)('cart', () => {
  const db = testDatabase() as Database;
  const app = createTestApp({ db });
  let me: Customer;
  let category: string;

  const add = (productId: string, quantity: number, who: Customer = me) =>
    as(app, who).post(ITEMS, { product_id: productId, quantity });
  const read = async (who: Customer = me) =>
    (await (await as(app, who).get(CART)).json()) as CartBody;
  const cartRows = async () =>
    Number((await db.query<{ n: number }>('SELECT count(*)::int8 AS n FROM carts')).rows[0]!.n);

  beforeEach(async () => {
    await resetDatabase(db);
    me = await customer(db);
    category = await addCategory(db, 'cart-cat');
  });

  it('reading an empty cart does not create one', async () => {
    const response = await as(app, me).get(CART);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      items: [],
      item_count: 0,
      subtotal_uzs: 0,
      total_uzs: 0,
      has_issues: false,
    });
    expect(await cartRows()).toBe(0);
  });

  it('adds, accumulates, keeps insertion order, sets and deletes idempotently', async () => {
    const apple = await addProduct(db, category, 'apple', { price: 12_000, stock: null });
    const pear = await addProduct(db, category, 'pear', { price: 5_000, stock: null });
    await add(pear, 1);
    await add(apple, 2);
    const response = await add(pear, 2);
    expect(response.status).toBe(200);
    const cart = (await response.json()) as CartBody;
    expect(cart.items.map((l) => [l.product.slug, l.quantity, l.line_total_uzs])).toEqual([
      ['pear', 3, 15_000],
      ['apple', 2, 24_000],
    ]);
    expect([cart.item_count, cart.subtotal_uzs, cart.total_uzs, cart.has_issues]).toEqual([
      5,
      39_000,
      39_000,
      false,
    ]);
    expect(Object.keys(cart.items[0]!)).toEqual(['product', 'quantity', 'line_total_uzs', 'issue']);

    const set = (await (
      await as(app, me).put(`${ITEMS}/${apple}`, { quantity: 7 })
    ).json()) as CartBody;
    expect(set.items.find((l) => l.product.slug === 'apple')?.quantity).toBe(7);

    for (let i = 0; i < 2; i += 1) {
      const removed = await as(app, me).delete(`${ITEMS}/${apple}`);
      expect(removed.status).toBe(200);
      expect(((await removed.json()) as CartBody).items.map((l) => l.product.slug)).toEqual([
        'pear',
      ]);
    }
  });

  it('setting the quantity of a missing line is 404', async () => {
    const apple = await addProduct(db, category, 'apple');
    await errorOf(
      await as(app, me).put(`${ITEMS}/${apple}`, { quantity: 1 }),
      404,
      'cart_item_not_found',
    );
    await add(apple, 1);
    const other = await addProduct(db, category, 'other');
    await errorOf(
      await as(app, me).put(`${ITEMS}/${other}`, { quantity: 1 }),
      404,
      'cart_item_not_found',
    );
  });

  it('keeps carts private per user', async () => {
    const apple = await addProduct(db, category, 'apple');
    const other = await customer(db);
    await add(apple, 2);
    expect((await read(other)).items).toEqual([]);
    expect((await read()).items).toHaveLength(1);
  });

  it('refuses unknown and inactive products (also in a hidden category chain)', async () => {
    await errorOf(await add(crypto.randomUUID(), 1), 404, 'product_not_found');
    expect(await cartRows()).toBe(0);
    const inactive = await addProduct(db, category, 'inactive', { isActive: false });
    await errorOf(await add(inactive, 1), 409, 'product_inactive');
    const hidden = await addCategory(db, 'hidden', { isActive: false });
    const child = await addCategory(db, 'child', { parentId: hidden });
    const deep = await addProduct(db, child, 'deep');
    await errorOf(await add(deep, 1), 409, 'product_inactive');
  });

  it('checks stock on the accumulated quantity and reports available_quantity', async () => {
    const apple = await addProduct(db, category, 'apple', { stock: 3 });
    expect((await add(apple, 3)).status).toBe(200);
    const error = await errorOf(await add(apple, 1), 409, 'insufficient_stock');
    expect(error['available_quantity']).toBe(3);
    const empty = await addProduct(db, category, 'empty', { stock: 0 });
    expect(
      (await errorOf(await add(empty, 1), 409, 'insufficient_stock'))['available_quantity'],
    ).toBe(0);
    const set = await as(app, me).put(`${ITEMS}/${apple}`, { quantity: 4 });
    expect((await errorOf(set, 409, 'insufficient_stock'))['available_quantity']).toBe(3);
  });

  it('caps a line at 99 (422 on the quantity) and a cart at 50 lines', async () => {
    const free = await addProduct(db, category, 'free', { stock: null });
    await add(free, 99);
    const error = await errorOf(await add(free, 1), 422, 'validation_error');
    expect(error['details']).toEqual([
      { loc: ['body', 'quantity'], msg: 'Quantity per item cannot exceed 99' },
    ]);
    for (let i = 1; i < 50; i += 1) {
      await add(await addProduct(db, category, `p${i}`, { stock: null }), 1);
    }
    const extra = await addProduct(db, category, 'extra', { stock: null });
    await errorOf(await add(extra, 1), 409, 'cart_limit_reached');
  });

  it('flags lines whose product went away or lost stock and excludes them from totals', async () => {
    const apple = await addProduct(db, category, 'apple', { price: 10_000, stock: 5 });
    const pear = await addProduct(db, category, 'pear', { price: 3_000, stock: null });
    await add(apple, 4);
    await add(pear, 1);
    await db.query('UPDATE products SET stock_quantity = 2 WHERE id = $1', [apple]);
    let cart = await read();
    expect(cart.items.map((l) => l.issue)).toEqual(['insufficient_stock', null]);
    expect([cart.item_count, cart.subtotal_uzs, cart.has_issues]).toEqual([1, 3_000, true]);
    await db.query('UPDATE categories SET is_active = false WHERE id = $1', [category]);
    cart = await read();
    expect(cart.items.map((l) => l.issue)).toEqual(['product_inactive', 'product_inactive']);
    expect(cart.items[0]!.line_total_uzs).toBe(40_000);
  });

  it('validates bodies and paths after the session and CSRF checks', async () => {
    const apple = await addProduct(db, category, 'apple');
    for (const body of [
      {},
      { product_id: apple, quantity: 0 },
      { product_id: 'x', quantity: 1 },
      { product_id: apple, quantity: 1, price_uzs: 1 },
    ]) {
      await errorOf(await as(app, me).post(ITEMS, body), 422, 'validation_error');
    }
    const badPath = await errorOf(
      await as(app, me).put(`${ITEMS}/not-a-uuid`, { quantity: 1 }),
      422,
      'validation_error',
    );
    expect((badPath['details'] as { loc: string[] }[])[0]!.loc).toEqual(['path', 'product_id']);
    // Malformed JSON is refused before anything else (FastAPI decodes the body first).
    const malformed = await call(app, 'POST', ITEMS, {
      body: '{',
      headers: { 'content-type': 'application/json' },
    });
    await errorOf(malformed, 422, 'validation_error');
  });

  it('requires a session everywhere and the CSRF token on writes', async () => {
    const apple = await addProduct(db, category, 'apple');
    for (const [method, path] of [
      ['GET', CART],
      ['POST', ITEMS],
      ['PUT', `${ITEMS}/${apple}`],
      ['DELETE', `${ITEMS}/${apple}`],
    ] as const) {
      const response = await call(
        app,
        method,
        path,
        method === 'POST' || method === 'PUT' ? { json: { quantity: 1, product_id: apple } } : {},
      );
      await errorOf(response, 401, 'session_required');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    const noToken = await call(app, 'POST', ITEMS, {
      cookie: me.session.cookie,
      json: { product_id: apple, quantity: 1 },
    });
    await errorOf(noToken, 403, 'csrf_failed');
    // An invalid body still loses to the CSRF check.
    const both = await call(app, 'POST', ITEMS, { cookie: me.session.cookie, json: {} });
    await errorOf(both, 403, 'csrf_failed');
    expect((await read()).items).toEqual([]);
  });

  it('concurrent adds never exceed stock and all count when stock allows', async () => {
    const limited = await addProduct(db, category, 'limited', { stock: 5 });
    const results = await Promise.all(Array.from({ length: 8 }, () => add(limited, 1)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect((await read()).items[0]!.quantity).toBe(5);

    const others = await Promise.all(Array.from({ length: 4 }, () => customer(db)));
    const first = await addProduct(db, category, 'first', { stock: null });
    const outcomes = await Promise.all(others.map((who) => add(first, 2, who)));
    expect(outcomes.every((r) => r.status === 200)).toBe(true);
    expect(await cartRows()).toBe(5);
  });
});
