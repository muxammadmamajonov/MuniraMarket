/** Public catalog over HTTP against the Alembic schema (port of test_catalog_{api,integration}.py). */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  call,
  hasDatabase,
  resetDatabase,
  testDatabase,
} from '../helpers/harness.ts';
import { addCategory, addProduct, errorOf } from './catalog.seed.ts';
import type { Database } from '../../src/db.ts';

const CACHE = 'public, max-age=60';

describe.skipIf(!hasDatabase)('catalog', () => {
  const db = testDatabase() as Database;
  const app = createTestApp({ db });
  const get = (path: string) => call(app, 'GET', path, { entrance: 'public' });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  it('returns the category tree ordered at every level; inactive hides its subtree', async () => {
    const b = await addCategory(db, 'b', { sortOrder: 2 });
    const a = await addCategory(db, 'a', { sortOrder: 1 });
    await addCategory(db, 'a-2', { parentId: a, sortOrder: 2 });
    await addCategory(db, 'a-1', { parentId: a, sortOrder: 1 });
    const hidden = await addCategory(db, 'hidden', { parentId: b, isActive: false });
    await addCategory(db, 'under-hidden', { parentId: hidden });

    const response = await get('/api/v1/categories');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(CACHE);
    const body = (await response.json()) as {
      items: { slug: string; children: { slug: string }[] }[];
    };
    expect(body.items.map((n) => n.slug)).toEqual(['a', 'b']);
    expect(body.items[0]!.children.map((n) => n.slug)).toEqual(['a-1', 'a-2']);
    expect(body.items[1]!.children).toEqual([]);
    expect(Object.keys(body.items[0]!)).toEqual([
      'id',
      'slug',
      'name_uz',
      'name_ru',
      'image_url',
      'sort_order',
      'children',
    ]);
  });

  it('lists only active products in visible categories, with the reference page shape', async () => {
    const root = await addCategory(db, 'root');
    const child = await addCategory(db, 'child', { parentId: root });
    const off = await addCategory(db, 'off', { isActive: false });
    const visible = await addProduct(db, child, 'visible', { price: 12_500, stock: null });
    await addProduct(db, child, 'inactive', { isActive: false });
    await addProduct(db, off, 'in-hidden');

    const response = await get('/api/v1/products');
    expect(response.headers.get('cache-control')).toBe(CACHE);
    const body = (await response.json()) as { items: object[] };
    expect(body).toEqual({
      items: [
        {
          id: visible,
          slug: 'visible',
          sku: expect.any(String),
          name_uz: 'Demo visible',
          name_ru: 'Демо visible',
          unit: 'piece',
          price_uzs: 12_500,
          old_price_uzs: null,
          stock_quantity: null,
          in_stock: true,
          low_stock: false,
          image_url: null,
          category_id: child,
        },
      ],
      page: 1,
      page_size: 24,
      total: 1,
      total_pages: 1,
    });
    expect(Object.keys(body.items[0]!)).toEqual([
      'id',
      'slug',
      'sku',
      'name_uz',
      'name_ru',
      'unit',
      'price_uzs',
      'old_price_uzs',
      'stock_quantity',
      'in_stock',
      'low_stock',
      'image_url',
      'category_id',
    ]);
  });

  it('searches names and SKU case-insensitively, trimmed, with wildcards matched literally', async () => {
    const cat = await addCategory(db, 'cat');
    await addProduct(db, cat, 'milk', {
      nameUz: 'Sut Lactel',
      nameRu: 'Молоко Лактель',
      sku: 'MLK-001',
    });
    await addProduct(db, cat, 'pct', { nameUz: 'Chegirma 50% off', sku: 'PCT-1' });
    await addProduct(db, cat, 'under', { nameUz: 'a_b mahsulot', sku: 'UND-1' });
    await addProduct(db, cat, 'slash', { nameUz: 'back\\slash', sku: 'BSL-1' });
    await addProduct(db, cat, 'plain', { nameUz: 'axb 50 off', sku: 'PLN-1' });
    const slugs = async (q: string) =>
      (
        (await (await get(`/api/v1/products?q=${encodeURIComponent(q)}&sort=name`)).json()) as {
          items: { slug: string }[];
        }
      ).items.map((i) => i.slug);

    expect(await slugs('  SUT ')).toEqual(['milk']);
    expect(await slugs('молоко')).toEqual(['milk']);
    expect(await slugs('mlk-0')).toEqual(['milk']);
    expect(await slugs('50%')).toEqual(['pct']);
    expect(await slugs('a_b')).toEqual(['under']);
    expect(await slugs('k\\s')).toEqual(['slash']);
    expect(await slugs('zzz')).toEqual([]);
  });

  it('filters by category including active descendants; unknown or hidden is 404', async () => {
    const root = await addCategory(db, 'root');
    const child = await addCategory(db, 'child', { parentId: root });
    const grandchild = await addCategory(db, 'grandchild', { parentId: child });
    const hidden = await addCategory(db, 'hidden', { parentId: root, isActive: false });
    const other = await addCategory(db, 'other');
    await addProduct(db, root, 'p-root');
    await addProduct(db, grandchild, 'p-grand');
    await addProduct(db, hidden, 'p-hidden');
    await addProduct(db, other, 'p-other');

    const body = (await (await get('/api/v1/products?category=root&sort=name')).json()) as {
      items: { slug: string }[];
    };
    expect(body.items.map((i) => i.slug)).toEqual(['p-grand', 'p-root']);

    for (const slug of ['nope', 'hidden']) {
      const response = await get(`/api/v1/products?category=${slug}`);
      await errorOf(response, 404, 'category_not_found');
      expect(response.headers.get('cache-control')).not.toBe(CACHE);
    }
  });

  it('paginates with stable ordering and every sort', async () => {
    const cat = await addCategory(db, 'cat');
    for (let i = 0; i < 5; i += 1) {
      await addProduct(db, cat, `p${i}`, {
        price: 1000 * ((i % 3) + 1),
        nameUz: `N${4 - i}`,
        createdAt: `2026-10-0${i + 1}T00:00:00Z`,
      });
    }
    const page = async (query: string) =>
      (await (await get(`/api/v1/products?${query}`)).json()) as {
        items: { slug: string; price_uzs: number }[];
        total: number;
        total_pages: number;
      };
    const first = await page('page_size=2');
    expect([first.total, first.total_pages]).toEqual([5, 3]);
    expect(first.items.map((i) => i.slug)).toEqual(['p4', 'p3']);
    expect((await page('page=3&page_size=2')).items.map((i) => i.slug)).toEqual(['p0']);
    expect((await page('page=4&page_size=2')).items).toEqual([]);
    expect((await page('sort=name')).items.map((i) => i.slug)).toEqual([
      'p4',
      'p3',
      'p2',
      'p1',
      'p0',
    ]);
    const asc = (await page('sort=price_asc')).items.map((i) => i.price_uzs);
    expect(asc).toEqual([...asc].sort((x, y) => x - y));
    const desc = (await page('sort=price_desc')).items.map((i) => i.price_uzs);
    expect(desc).toEqual([...desc].sort((x, y) => y - x));
  });

  it('flags stock and filters in_stock keeping untracked products', async () => {
    const cat = await addCategory(db, 'cat');
    await addProduct(db, cat, 'tracked', { stock: 3 });
    await addProduct(db, cat, 'untracked', { stock: null });
    await addProduct(db, cat, 'empty', { stock: 0 });
    const all = (await (await get('/api/v1/products?sort=name')).json()) as {
      items: { slug: string; in_stock: boolean }[];
    };
    expect(Object.fromEntries(all.items.map((i) => [i.slug, i.in_stock]))).toEqual({
      empty: false,
      tracked: true,
      untracked: true,
    });
    const filtered = (await (await get('/api/v1/products?in_stock=true&sort=name')).json()) as {
      items: { slug: string }[];
    };
    expect(filtered.items.map((i) => i.slug)).toEqual(['tracked', 'untracked']);
  });

  it('validates query parameters like FastAPI', async () => {
    for (const query of [
      'page=0',
      'page_size=49',
      'q=a',
      'q=%20%20a%20',
      'sort=cheap',
      'in_stock=maybe',
      'page=1000001',
    ]) {
      const error = await errorOf(await get(`/api/v1/products?${query}`), 422, 'validation_error');
      const details = error['details'] as { loc: string[] }[];
      expect(details[0]!.loc[0]).toBe('query');
    }
    expect((await get('/api/v1/products?page_size=48&page=1000000')).status).toBe(200);
  });

  it('returns product detail and 404s for hidden products', async () => {
    const cat = await addCategory(db, 'cat');
    const id = await addProduct(db, cat, 'detail', {
      oldPrice: 15_000,
      price: 12_000,
      brand: 'Demo',
      description: 'Tavsif',
      stock: 0,
    });
    const off = await addCategory(db, 'off', { isActive: false });
    await addProduct(db, off, 'hidden');
    await addProduct(db, cat, 'inactive', { isActive: false });

    const response = await get('/api/v1/products/detail');
    expect(response.headers.get('cache-control')).toBe(CACHE);
    const body = (await response.json()) as object;
    expect(body).toMatchObject({
      id,
      old_price_uzs: 15_000,
      stock_quantity: 0,
      in_stock: false,
      description_uz: 'Tavsif',
      description_ru: 'Tavsif',
      brand: 'Demo',
      category: { id: cat, slug: 'cat', name_uz: 'Demo cat', name_ru: 'Демо cat' },
    });
    expect(Object.keys(body).slice(-5)).toEqual([
      'category_id',
      'description_uz',
      'description_ru',
      'brand',
      'category',
    ]);
    for (const slug of ['hidden', 'inactive', 'missing']) {
      await errorOf(await get(`/api/v1/products/${slug}`), 404, 'product_not_found');
    }
  });

  it('needs no session and is rate limited per IP with a no-store 429', async () => {
    for (let i = 0; i < 300; i += 1) {
      const response = await call(app, 'GET', '/api/v1/categories', { ip: '198.51.100.7' });
      expect(response.status).toBe(200);
    }
    const limited = await call(app, 'GET', '/api/v1/products', { ip: '198.51.100.7' });
    await errorOf(limited, 429, 'rate_limited');
    expect(limited.headers.get('cache-control')).toBe('no-store');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });
});
