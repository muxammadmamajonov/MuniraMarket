/**
 * Shared helpers of the admin integration tests: back-office calls with an admin-origin session
 * (CSRF headers on writes) and SQL seeds with obviously fake data.
 */
import type { Hono } from 'hono';
import type { Database } from '../../src/db.ts';
import type { AppBindings, UserRecord } from '../../src/http/context.ts';
import { call } from '../helpers/harness.ts';
import { createSession, createStaff, createUser, type TestSession } from '../helpers/fixtures.ts';

export type App = Hono<AppBindings>;

export interface Actor {
  user: UserRecord;
  session: TestSession;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface AdminCallOptions {
  json?: unknown;
  body?: string | Uint8Array;
  headers?: Record<string, string>;
  /** Leave out the CSRF headers on a write. */
  noCsrf?: boolean;
}

/** A back-office request through the admin entrance with `actor`'s session. */
export function adminCall(
  app: App,
  actor: Actor | null,
  method: string,
  path: string,
  options: AdminCallOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (actor && UNSAFE.has(method) && !options.noCsrf)
    Object.assign(headers, actor.session.writeHeaders);
  Object.assign(headers, options.headers ?? {});
  return call(app, method, path, {
    entrance: 'admin',
    ...(actor ? { cookie: actor.session.cookie } : {}),
    headers,
    ...(options.json !== undefined ? { json: options.json } : {}),
    ...(options.body !== undefined ? { body: options.body } : {}),
  });
}

export async function staff(db: Database, role: 'operator' | 'admin'): Promise<Actor> {
  return createStaff(db, role);
}

/** A customer with an admin-origin OIDC session (the role check must refuse it). */
export async function customer(db: Database): Promise<Actor> {
  const user = await createUser(db);
  return { user, session: await createSession(db, user, { entrance: 'admin' }) };
}

/** An admin whose session is a storefront (Mini App) one: never a back-office credential. */
export async function storefrontAdmin(db: Database): Promise<Actor> {
  const user = await createUser(db, { role: 'admin' });
  return { user, session: await createSession(db, user, { entrance: 'storefront' }) };
}

export async function errorOf(
  response: Response,
): Promise<{ code: string; message: string } & Record<string, unknown>> {
  const body = (await response.json()) as {
    error: { code: string; message: string } & Record<string, unknown>;
  };
  return body.error;
}

export async function addCategory(
  db: Database,
  slug: string,
  options: { parentId?: string | null; sortOrder?: number; isActive?: boolean } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO categories (id, parent_id, slug, name_uz, name_ru, sort_order, is_active)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6) RETURNING id::text AS id`,
    [
      options.parentId ?? null,
      slug,
      `Demo ${slug}`,
      `Демо ${slug}`,
      options.sortOrder ?? 0,
      options.isActive ?? true,
    ],
  );
  return rows[0]!.id;
}

export async function addProduct(
  db: Database,
  categoryId: string,
  sku: string,
  options: {
    slug?: string;
    price?: number;
    stock?: number | null;
    isActive?: boolean;
    archived?: boolean;
  } = {},
): Promise<string> {
  const archived = options.archived ?? false;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO products (id, category_id, sku, slug, name_uz, name_ru, unit, price_uzs,
                           stock_quantity, is_active, archived_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'piece', $6, $7, $8, $9)
     RETURNING id::text AS id`,
    [
      categoryId,
      sku,
      options.slug ?? sku.toLowerCase(),
      `Demo ${sku}`,
      `Демо ${sku}`,
      options.price ?? 10_000,
      options.stock === undefined ? 10 : options.stock,
      archived ? false : (options.isActive ?? true),
      archived ? new Date() : null,
    ],
  );
  return rows[0]!.id;
}

let orderNumber = 0;

/** A minimal order row (fake recipient data). */
export async function addOrder(
  db: Database,
  userId: string,
  options: {
    total?: number;
    status?: string;
    createdAt?: Date;
  } = {},
): Promise<string> {
  orderNumber += 1;
  const total = options.total ?? 50_000;
  const status = options.status ?? 'NEW';
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO orders (id, number, user_id, status, subtotal_uzs, total_uzs, payment_method,
                         recipient_name, recipient_phone, address_snapshot, cancel_reason,
                         idempotency_key, idempotency_request_hash, item_count, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $4, 'cash_on_delivery', 'Demo Person',
             '+998900000000', '{}'::jsonb, $5, $6, $7, 1, $8)
     RETURNING id::text AS id`,
    [
      `T-${Date.now()}-${orderNumber}`,
      userId,
      status,
      total,
      status === 'CANCELLED' ? 'test' : null,
      `key-${orderNumber}-${Math.random()}`,
      'a'.repeat(64),
      options.createdAt ?? new Date(),
    ],
  );
  return rows[0]!.id;
}

export async function auditRows(
  db: Database,
  where = 'true',
  params: unknown[] = [],
): Promise<
  Array<{
    action: string;
    entity_type: string;
    entity_id: string;
    actor_user_id: string | null;
    details: Record<string, unknown>;
  }>
> {
  const { rows } = await db.query(
    `SELECT action, entity_type, entity_id, actor_user_id::text AS actor_user_id, details
     FROM audit_log WHERE ${where} ORDER BY created_at, id`,
    params,
  );
  return rows as never;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

/** A response's JSON body, loosely typed for assertions. */
export async function jsonOf(response: Response | Promise<Response>): Promise<Json> {
  return (await response).json();
}
