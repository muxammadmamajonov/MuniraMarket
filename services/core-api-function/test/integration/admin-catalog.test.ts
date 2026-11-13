/** Admin catalog over HTTP (port of test_admin_catalog_{api,integration}.py). */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db.ts';
import { createTestApp, hasDatabase, resetDatabase, testDatabase } from '../helpers/harness.ts';
import {
  addCategory,
  addProduct,
  adminCall,
  auditRows,
  customer,
  errorOf,
  jsonOf,
  staff,
  storefrontAdmin,
  type Actor,
} from './admin-helpers.ts';

const UNKNOWN = '00000000-0000-4000-8000-000000000000';

const productBody = (categoryId: string, overrides: Record<string, unknown> = {}) => ({
  sku: 'DEMO-1',
  slug: 'demo-olma',
  category_id: categoryId,
  name_uz: 'Demo olma',
  name_ru: 'Демо яблоко',
  unit: 'kg',
  price_uzs: 12_000,
  ...overrides,
});

describe.skipIf(!hasDatabase)('admin catalog', () => {
  const db = testDatabase() as Database;
  const app = createTestApp({ db });
  let admin: Actor;

  beforeEach(async () => {
    await resetDatabase(db);
    admin = await staff(db, 'admin');
  });

  describe('role matrix', () => {
    const routes: Array<[string, (category: string, product: string) => string, unknown?]> = [
      ['GET', () => '/api/v1/admin/categories'],
      ['POST', () => '/api/v1/admin/categories', { slug: 'x', name_uz: 'X', name_ru: 'X' }],
      ['PATCH', (c) => `/api/v1/admin/categories/${c}`, { sort_order: 1 }],
      ['DELETE', (c) => `/api/v1/admin/categories/${c}`],
      ['GET', () => '/api/v1/admin/products'],
      ['GET', (_c, p) => `/api/v1/admin/products/${p}`],
      ['POST', () => '/api/v1/admin/products', {}],
      ['PATCH', (_c, p) => `/api/v1/admin/products/${p}`, { price_uzs: 1 }],
      ['DELETE', (_c, p) => `/api/v1/admin/products/${p}`],
      ['POST', (_c, p) => `/api/v1/admin/products/${p}/restore`],
    ];

    it('operators, customers and storefront sessions get the same 403 for existing and unknown ids', async () => {
      const category = await addCategory(db, 'mevalar');
      const product = await addProduct(db, category, 'DEMO-1');
      const actors = [await staff(db, 'operator'), await customer(db), await storefrontAdmin(db)];
      for (const actor of actors) {
        for (const [method, path, json] of routes) {
          for (const ids of [
            [category, product],
            [UNKNOWN, UNKNOWN],
          ] as const) {
            const response = await adminCall(app, actor, method, path(ids[0], ids[1]), { json });
            expect(response.status, `${method} ${path(ids[0], ids[1])}`).toBe(403);
            expect((await errorOf(response)).code).toBe('forbidden');
          }
        }
      }
      expect(await auditRows(db)).toEqual([]);
      const unchanged = await db.query(
        'SELECT 1 FROM products WHERE id = $1 AND archived_at IS NULL',
        [product],
      );
      expect(unchanged.rows).toHaveLength(1);
    });

    it('no session is 401; a write without the CSRF token is 403 csrf_failed', async () => {
      const anonymous = await adminCall(app, null, 'GET', '/api/v1/admin/categories');
      expect(anonymous.status).toBe(401);
      expect((await errorOf(anonymous)).code).toBe('session_required');
      const noCsrf = await adminCall(app, admin, 'POST', '/api/v1/admin/categories', {
        json: { slug: 'x', name_uz: 'X', name_ru: 'X' },
        noCsrf: true,
      });
      expect(noCsrf.status).toBe(403);
      expect((await errorOf(noCsrf)).code).toBe('csrf_failed');
    });

    it('the role check runs before path and body validation', async () => {
      const operator = await staff(db, 'operator');
      const response = await adminCall(
        app,
        operator,
        'PATCH',
        '/api/v1/admin/categories/not-a-uuid',
        {
          json: { bogus: 1 },
        },
      );
      expect(response.status).toBe(403);
      const asAdmin = await adminCall(app, admin, 'PATCH', '/api/v1/admin/categories/not-a-uuid', {
        json: { bogus: 1 },
      });
      expect(asAdmin.status).toBe(422);
      expect((await errorOf(asAdmin)).details).toEqual([
        { loc: ['path', 'category_id'], msg: 'Input should be a valid UUID' },
        { loc: ['body', 'bogus'], msg: 'Extra inputs are not permitted' },
      ]);
    });
  });

  describe('categories', () => {
    it('creates, lists (flat, with counts), updates and deletes with audit rows', async () => {
      const created = await adminCall(app, admin, 'POST', '/api/v1/admin/categories', {
        json: { slug: ' mevalar ', name_uz: 'Mevalar', name_ru: 'Фрукты', sort_order: 2 },
      });
      expect(created.status).toBe(201);
      const category = await jsonOf(created);
      expect(Object.keys(category)).toEqual([
        'id',
        'parent_id',
        'slug',
        'name_uz',
        'name_ru',
        'image_url',
        'sort_order',
        'is_active',
        'product_count',
        'child_count',
        'created_at',
        'updated_at',
      ]);
      expect(category).toMatchObject({
        parent_id: null,
        slug: 'mevalar',
        sort_order: 2,
        is_active: true,
      });
      expect(category.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{6})?Z$/);

      const child = await adminCall(app, admin, 'POST', '/api/v1/admin/categories', {
        json: {
          slug: 'olma',
          name_uz: 'Olma',
          name_ru: 'Яблоки',
          parent_id: category.id.toUpperCase(),
        },
      });
      expect(child.status).toBe(201);
      const childBody = await jsonOf(child);
      expect(childBody.parent_id).toBe(category.id);
      await addProduct(db, category.id, 'DEMO-1', { archived: true });

      const list = await jsonOf(adminCall(app, admin, 'GET', '/api/v1/admin/categories'));
      expect(list.items.map((c: { slug: string }) => c.slug)).toEqual(['olma', 'mevalar']);
      expect(list.items[1]).toMatchObject({ product_count: 1, child_count: 1 });

      const patched = await adminCall(
        app,
        admin,
        'PATCH',
        `/api/v1/admin/categories/${childBody.id}`,
        {
          json: { parent_id: null, name_uz: 'Olmalar' },
        },
      );
      expect(patched.status).toBe(200);
      expect(await jsonOf(patched)).toMatchObject({ parent_id: null, name_uz: 'Olmalar' });

      const blocked = await adminCall(
        app,
        admin,
        'DELETE',
        `/api/v1/admin/categories/${category.id}`,
      );
      expect(blocked.status).toBe(409);
      expect((await errorOf(blocked)).code).toBe('category_not_empty');
      const deleted = await adminCall(
        app,
        admin,
        'DELETE',
        `/api/v1/admin/categories/${childBody.id}`,
      );
      expect(deleted.status).toBe(204);
      expect(await deleted.text()).toBe('');

      const audit = await auditRows(db);
      expect(audit.map((row) => row.action)).toEqual([
        'category.create',
        'category.create',
        'category.update',
        'category.delete',
      ]);
      expect(audit[0]!.actor_user_id).toBe(admin.user.id);
      expect(audit[0]!.details).toEqual({
        changes: {
          slug: { from: null, to: 'mevalar' },
          name_uz: { from: null, to: 'Mevalar' },
          name_ru: { from: null, to: 'Фрукты' },
          parent_id: { from: null, to: null },
          image_url: { from: null, to: null },
          sort_order: { from: null, to: 2 },
          is_active: { from: null, to: true },
        },
      });
      expect(audit[2]!.details).toEqual({
        changes: {
          name_uz: { from: 'Olma', to: 'Olmalar' },
          parent_id: { from: category.id, to: null },
        },
      });
      expect(audit[3]!.details).toEqual({ slug: 'olma' });
    });

    it('slug_taken, unknown parent, cycles, 404 and PATCH rules', async () => {
      const root = await addCategory(db, 'root');
      const child = await addCategory(db, 'child', { parentId: root });
      const grandchild = await addCategory(db, 'grandchild', { parentId: child });

      const taken = await adminCall(app, admin, 'POST', '/api/v1/admin/categories', {
        json: { slug: 'root', name_uz: 'X', name_ru: 'X' },
      });
      expect(taken.status).toBe(409);
      expect((await errorOf(taken)).code).toBe('slug_taken');

      const unknownParent = await adminCall(app, admin, 'POST', '/api/v1/admin/categories', {
        json: { slug: 'new', name_uz: 'X', name_ru: 'X', parent_id: UNKNOWN },
      });
      expect(unknownParent.status).toBe(422);
      expect(await errorOf(unknownParent)).toEqual({
        code: 'category_not_found',
        message: 'Category not found',
        details: [{ loc: ['body', 'parent_id'], msg: 'Category not found' }],
      });

      for (const target of [root, grandchild]) {
        const cycle = await adminCall(app, admin, 'PATCH', `/api/v1/admin/categories/${root}`, {
          json: { parent_id: target },
        });
        expect(cycle.status).toBe(409);
        expect((await errorOf(cycle)).code).toBe('category_cycle');
      }

      const missing = await adminCall(app, admin, 'PATCH', `/api/v1/admin/categories/${UNKNOWN}`, {
        json: { sort_order: 1 },
      });
      expect(missing.status).toBe(404);
      expect((await errorOf(missing)).code).toBe('category_not_found');

      const empty = await adminCall(app, admin, 'PATCH', `/api/v1/admin/categories/${child}`, {
        json: {},
      });
      expect(empty.status).toBe(422);
      expect((await errorOf(empty)).details).toEqual([
        { loc: ['body'], msg: 'Value error, send at least one field' },
      ]);
      const nullSlug = await adminCall(app, admin, 'PATCH', `/api/v1/admin/categories/${child}`, {
        json: { slug: null },
      });
      expect((await errorOf(nullSlug)).details).toEqual([
        { loc: ['body'], msg: 'Value error, slug cannot be null' },
      ]);

      const unchanged = await adminCall(app, admin, 'PATCH', `/api/v1/admin/categories/${child}`, {
        json: { slug: 'child' },
      });
      expect(unchanged.status).toBe(200);
      expect(await auditRows(db)).toEqual([]);
    });

    it('validation messages follow Pydantic', async () => {
      const response = await adminCall(app, admin, 'POST', '/api/v1/admin/categories', {
        json: {
          slug: 'Bad Slug',
          name_uz: 'Ol\u200bma',
          name_ru: '',
          image_url: 'http://cdn.example.com/a.png',
          sort_order: 'x',
        },
      });
      expect(response.status).toBe(422);
      const error = await errorOf(response);
      expect(error.code).toBe('validation_error');
      expect(error.details).toEqual([
        { loc: ['body', 'slug'], msg: "String should match pattern '^[a-z0-9]+(?:-[a-z0-9]+)*$'" },
        {
          loc: ['body', 'name_uz'],
          msg: 'Value error, must not contain invisible or text-direction characters (e.g. U+200B, U+202E, U+FEFF)',
        },
        { loc: ['body', 'name_ru'], msg: 'String should have at least 1 character' },
        { loc: ['body', 'image_url'], msg: 'Value error, must use https' },
        {
          loc: ['body', 'sort_order'],
          msg: 'Input should be a valid integer, unable to parse string as an integer',
        },
      ]);
      const malformed = await adminCall(app, admin, 'POST', '/api/v1/admin/categories', {
        body: '{"slug":',
        headers: { 'content-type': 'application/json' },
      });
      expect(malformed.status).toBe(422);
      expect((await errorOf(malformed)).details).toEqual([
        expect.objectContaining({ msg: 'JSON decode error' }),
      ]);
    });
  });

  describe('products', () => {
    it('create, get, list/search/paginate, update, archive and restore with audit', async () => {
      const category = await addCategory(db, 'mevalar');
      const created = await adminCall(app, admin, 'POST', '/api/v1/admin/products', {
        json: productBody(category, {
          description_uz: '  Shirin\r\nolma  ',
          old_price_uzs: 15_000,
          stock_quantity: 5,
          image_url: '',
        }),
      });
      expect(created.status).toBe(201);
      const product = await jsonOf(created);
      expect(Object.keys(product)).toEqual([
        'id',
        'sku',
        'slug',
        'category_id',
        'name_uz',
        'name_ru',
        'description_uz',
        'description_ru',
        'unit',
        'price_uzs',
        'old_price_uzs',
        'stock_quantity',
        'safety_stock',
        'sellable_quantity',
        'image_url',
        'sort_order',
        'is_active',
        'archived_at',
        'created_at',
        'updated_at',
      ]);
      expect(product).toMatchObject({
        description_uz: 'Shirin\nolma',
        description_ru: null,
        image_url: null,
        price_uzs: 12_000,
        old_price_uzs: 15_000,
        archived_at: null,
      });

      const fetched = await adminCall(app, admin, 'GET', `/api/v1/admin/products/${product.id}`);
      expect(await jsonOf(fetched)).toEqual(product);
      for (let i = 2; i <= 4; i += 1) await addProduct(db, category, `DEMO-${i}`);
      await addProduct(db, category, 'GONE-1', { archived: true });

      const page = await jsonOf(
        adminCall(app, admin, 'GET', '/api/v1/admin/products?page=2&page_size=3'),
      );
      expect(page).toMatchObject({ page: 2, page_size: 3, total: 4, total_pages: 2 });
      expect(page.items).toHaveLength(1);
      const beyond = await jsonOf(adminCall(app, admin, 'GET', '/api/v1/admin/products?page=9'));
      expect(beyond).toEqual({ items: [], page: 9, page_size: 20, total: 4, total_pages: 1 });
      const search = await jsonOf(
        adminCall(app, admin, 'GET', '/api/v1/admin/products?q=%20demo-3%20'),
      );
      expect(search.items.map((p: { sku: string }) => p.sku)).toEqual(['DEMO-3']);
      const likeEscaped = await jsonOf(
        adminCall(app, admin, 'GET', '/api/v1/admin/products?q=%25'),
      );
      expect(likeEscaped.total).toBe(0);
      const archivedOnly = await jsonOf(
        adminCall(app, admin, 'GET', '/api/v1/admin/products?status=archived'),
      );
      expect(archivedOnly.items.map((p: { sku: string }) => p.sku)).toEqual(['GONE-1']);
      const all = await jsonOf(adminCall(app, admin, 'GET', '/api/v1/admin/products?status=all'));
      expect(all.total).toBe(5);
      const badQuery = await adminCall(app, admin, 'GET', '/api/v1/admin/products?status=x&page=0');
      expect((await errorOf(badQuery)).details).toEqual([
        {
          loc: ['query', 'status'],
          msg: "Input should be 'active', 'inactive', 'archived' or 'all'",
        },
        { loc: ['query', 'page'], msg: 'Input should be greater than or equal to 1' },
      ]);

      const patched = await adminCall(app, admin, 'PATCH', `/api/v1/admin/products/${product.id}`, {
        json: { price_uzs: 13_000, stock_quantity: null, description_uz: null },
      });
      expect(patched.status).toBe(200);
      expect(await jsonOf(patched)).toMatchObject({
        price_uzs: 13_000,
        stock_quantity: null,
        description_uz: null,
      });
      const badOldPrice = await adminCall(
        app,
        admin,
        'PATCH',
        `/api/v1/admin/products/${product.id}`,
        {
          json: { price_uzs: 20_000 },
        },
      );
      expect(badOldPrice.status).toBe(422);
      expect((await errorOf(badOldPrice)).details).toEqual([
        { loc: ['body', 'old_price_uzs'], msg: 'old_price_uzs must be above price_uzs' },
      ]);

      const archived = await adminCall(
        app,
        admin,
        'DELETE',
        `/api/v1/admin/products/${product.id}`,
      );
      expect(archived.status).toBe(200);
      const archivedBody = await jsonOf(archived);
      expect(archivedBody.is_active).toBe(false);
      expect(archivedBody.archived_at).not.toBeNull();
      const again = await adminCall(app, admin, 'DELETE', `/api/v1/admin/products/${product.id}`);
      expect(again.status).toBe(200);
      const editArchived = await adminCall(
        app,
        admin,
        'PATCH',
        `/api/v1/admin/products/${product.id}`,
        {
          json: { is_active: true },
        },
      );
      expect(editArchived.status).toBe(409);
      expect((await errorOf(editArchived)).code).toBe('product_archived');
      const restored = await adminCall(
        app,
        admin,
        'POST',
        `/api/v1/admin/products/${product.id}/restore`,
      );
      expect(await jsonOf(restored)).toMatchObject({ archived_at: null, is_active: false });

      const audit = await auditRows(db, "entity_type = 'product'");
      expect(audit.map((row) => row.action)).toEqual([
        'product.create',
        'product.update',
        'product.archive',
        'product.restore',
      ]);
      const createChanges = (audit[0]!.details as { changes: Record<string, unknown> }).changes;
      expect(createChanges).not.toHaveProperty('description_uz');
      expect(createChanges['unit']).toEqual({ from: null, to: 'kg' });
      expect(audit[1]!.details).toEqual({
        changes: { price_uzs: { from: 12_000, to: 13_000 }, stock_quantity: { from: 5, to: null } },
      });
      expect(audit[2]!.details).toEqual({
        changes: { archived: { from: false, to: true }, is_active: { from: true, to: false } },
        sku: 'DEMO-1',
      });
      expect(audit[3]!.details).toEqual({
        changes: { archived: { from: true, to: false } },
        sku: 'DEMO-1',
      });
    });

    it('sku_taken, slug_taken, unknown category, old price and 404', async () => {
      const category = await addCategory(db, 'mevalar');
      await addProduct(db, category, 'DEMO-1', { slug: 'taken' });
      const sku = await adminCall(app, admin, 'POST', '/api/v1/admin/products', {
        json: productBody(category, { slug: 'free' }),
      });
      expect(sku.status).toBe(409);
      expect((await errorOf(sku)).code).toBe('sku_taken');
      const slug = await adminCall(app, admin, 'POST', '/api/v1/admin/products', {
        json: productBody(category, { sku: 'DEMO-2', slug: 'taken' }),
      });
      expect(slug.status).toBe(409);
      expect((await errorOf(slug)).code).toBe('slug_taken');
      const unknown = await adminCall(app, admin, 'POST', '/api/v1/admin/products', {
        json: productBody(UNKNOWN, { sku: 'DEMO-3', slug: 'three' }),
      });
      expect(unknown.status).toBe(422);
      expect((await errorOf(unknown)).details).toEqual([
        { loc: ['body', 'category_id'], msg: 'Category not found' },
      ]);
      const oldPrice = await adminCall(app, admin, 'POST', '/api/v1/admin/products', {
        json: productBody(category, { sku: 'DEMO-4', slug: 'four', old_price_uzs: 12_000 }),
      });
      expect((await errorOf(oldPrice)).details).toEqual([
        { loc: ['body'], msg: 'Value error, old_price_uzs must be above price_uzs' },
      ]);
      const missing = await adminCall(app, admin, 'GET', `/api/v1/admin/products/${UNKNOWN}`);
      expect(missing.status).toBe(404);
      expect((await errorOf(missing)).code).toBe('product_not_found');
      const missingRestore = await adminCall(
        app,
        admin,
        'POST',
        `/api/v1/admin/products/${UNKNOWN}/restore`,
      );
      expect(missingRestore.status).toBe(404);
      const required = await adminCall(app, admin, 'POST', '/api/v1/admin/products', { json: {} });
      expect((await errorOf(required)).details).toContainEqual({
        loc: ['body', 'sku'],
        msg: 'Field required',
      });
      expect(await auditRows(db)).toEqual([]);
    });
  });

  it('responses are no-store', async () => {
    const response = await adminCall(app, admin, 'GET', '/api/v1/admin/categories');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
