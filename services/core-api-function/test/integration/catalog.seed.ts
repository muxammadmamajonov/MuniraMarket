/**
 * SQL seed helpers for the storefront integration tests (catalog, cart, checkout, orders): the
 * same rows services/api/tests/db_data.py writes, with obviously fake data.
 */
import type { Hono } from 'hono';
import { expect } from 'vitest';
import type { Database } from '../../src/db.ts';
import type { AppBindings, UserRecord } from '../../src/http/context.ts';
import { call } from '../helpers/harness.ts';
import { createSession, createUser, type TestSession } from '../helpers/fixtures.ts';

export async function addCategory(
  db: Database,
  slug: string,
  options: {
    parentId?: string | null;
    isActive?: boolean;
    sortOrder?: number;
    nameUz?: string;
  } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO categories (id, parent_id, slug, name_uz, name_ru, sort_order, is_active)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6) RETURNING id::text AS id`,
    [
      options.parentId ?? null,
      slug,
      options.nameUz ?? `Demo ${slug}`,
      `Демо ${slug}`,
      options.sortOrder ?? 0,
      options.isActive ?? true,
    ],
  );
  return rows[0]!.id;
}

export interface ProductOptions {
  price?: number;
  oldPrice?: number | null;
  stock?: number | null;
  sku?: string;
  isActive?: boolean;
  nameUz?: string;
  nameRu?: string;
  unit?: string;
  createdAt?: string;
  description?: string | null;
  brand?: string | null;
  imageUrl?: string | null;
}

let skuCounter = 0;

export async function addProduct(
  db: Database,
  categoryId: string,
  slug: string,
  options: ProductOptions = {},
): Promise<string> {
  skuCounter += 1;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO products (id, category_id, sku, slug, name_uz, name_ru, description_uz,
                           description_ru, brand, unit, price_uzs, old_price_uzs, stock_quantity,
                           is_active, image_url, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $6, $7, $8::unit, $9, $10, $11, $12, $13,
             COALESCE($14::timestamptz, now()), now())
     RETURNING id::text AS id`,
    [
      categoryId,
      options.sku ?? `DEMO-${String(skuCounter).padStart(5, '0')}`,
      slug,
      options.nameUz ?? `Demo ${slug}`,
      options.nameRu ?? `Демо ${slug}`,
      options.description ?? null,
      options.brand ?? null,
      options.unit ?? 'piece',
      options.price ?? 10_000,
      options.oldPrice ?? null,
      options.stock === undefined ? 10 : options.stock,
      options.isActive ?? true,
      options.imageUrl ?? null,
      options.createdAt ?? null,
    ],
  );
  return rows[0]!.id;
}

export async function connectStaffChat(db: Database, chatId = -1_001_234_567_890): Promise<void> {
  await db.query('INSERT INTO staff_notification_chat (id, chat_id) VALUES (1, $1)', [chatId]);
}

export interface Customer {
  user: UserRecord;
  session: TestSession;
}

export async function customer(db: Database, language: 'uz' | 'ru' = 'uz'): Promise<Customer> {
  const user = await createUser(db, { language });
  return { user, session: await createSession(db, user) };
}

type App = Hono<AppBindings>;

/** Signed-in storefront requests for one customer (CSRF headers on writes). */
export function as(app: App, who: Customer) {
  const write = (
    method: string,
    path: string,
    json?: unknown,
    headers: Record<string, string> = {},
  ) =>
    call(app, method, path, {
      cookie: who.session.cookie,
      headers: { ...who.session.writeHeaders, ...headers },
      ...(json === undefined ? {} : { json }),
    });
  return {
    get: (path: string) => call(app, 'GET', path, { cookie: who.session.cookie }),
    post: (path: string, json?: unknown, headers?: Record<string, string>) =>
      write('POST', path, json, headers),
    put: (path: string, json?: unknown) => write('PUT', path, json),
    patch: (path: string, json?: unknown) => write('PATCH', path, json),
    delete: (path: string) => write('DELETE', path),
  };
}

export async function addToCart(app: App, who: Customer, productId: string, quantity = 1) {
  const response = await as(app, who).post('/api/v1/cart/items', {
    product_id: productId,
    quantity,
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

export const DEMO_PHONE = '+998001234567';

/** A made-up point in Tashkent (WGS84). */
export const DEMO_POINT = { lat: 41.311081, lon: 69.240562 } as const;

export function orderBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: { ...DEMO_POINT, street: "Demo ko'cha", house: '12' },
    recipient_name: 'Demo Mijoz',
    recipient_phone: DEMO_PHONE,
    payment_method: 'cash_on_delivery',
    expected_total_uzs: 65_000,
    ...overrides,
  };
}

export function newKey(): string {
  return crypto.randomUUID();
}

export async function quotedTotal(app: App, who: Customer) {
  const response = await as(app, who).post('/api/v1/checkout/quote');
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { total_uzs: number }).total_uzs;
}

export function placeOrder(
  app: App,
  who: Customer,
  expectedTotal: number,
  overrides: Record<string, unknown> = {},
  key = newKey(),
) {
  return as(app, who).post(
    '/api/v1/orders',
    orderBody({ expected_total_uzs: expectedTotal, ...overrides }),
    {
      'idempotency-key': key,
    },
  );
}

/** Place whatever is in the customer's cart at the quoted total; returns the order body. */
export async function place(
  app: App,
  who: Customer,
): Promise<Record<string, unknown> & { id: string }> {
  const response = await placeOrder(app, who, await quotedTotal(app, who));
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as Record<string, unknown> & { id: string };
}

export async function errorOf(response: Response, status: number, code: string) {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  const body = JSON.parse(text) as { error: Record<string, unknown> };
  expect(body.error['code']).toBe(code);
  return body.error;
}

export async function stockOf(db: Database, productId: string): Promise<number | null> {
  const { rows } = await db.query<{ stock_quantity: number | null }>(
    'SELECT stock_quantity FROM products WHERE id = $1',
    [productId],
  );
  return rows[0]!.stock_quantity;
}
