/**
 * Checkout, orders and the order lifecycle (port of services/api/app/repositories/orders.py).
 *
 * Locking (every write is ONE `db.tx`; locks are always taken in this order, so concurrent writers
 * cannot deadlock):
 * 1. the customer's `carts` row (order creation) or the `orders` row (status changes),
 * 2. the affected `products` rows, `FOR UPDATE` in ascending id order.
 *
 * Order creation, under those locks: replay an earlier order with the same `Idempotency-Key`;
 * re-evaluate the cart against current prices, visibility and stock with the same pure function
 * as the quote; refuse unless the cart is clean and the total equals what the customer was shown
 * (delivery is on demand by a Yandex Go courier the customer pays, so there is no zone, fee,
 * minimum, opening hours or slot to check); then decrement tracked stock (bumping
 * `products.updated_at` like the ORM's `onupdate`), snapshot the address and the lines, write the
 * status history and the notification outbox rows, and empty the cart.
 *
 * Cancelling (by the customer, or an operator) returns tracked stock and writes an
 * `order.status_change` audit row (no reason text, no recipient data); so does every other status
 * change. Nothing is ever committed partially: any rule violation rolls the whole transaction back.
 */
import { randomInt, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { AuditEntity, recordAudit } from '../audit.ts';
import type { Database, Queryable } from '../db.ts';
import type { LineFacts } from '../domain/cart.ts';
import {
  CartEmptyError,
  IdempotencyKeyConflictError,
  InvalidStatusTransitionError,
  MAX_OPEN_ORDERS,
  OrderInsufficientStockError,
  OrderNotCancellableError,
  OrderNotFoundError,
  OrderProductUnavailableError,
  OrderStatusConflictError,
  PriceChangedError,
  TooManyOpenOrdersError,
  buildQuote,
  type CheckoutError,
  type QuoteTotals,
} from '../domain/checkout.ts';
import { canTransition, customerCanCancel, type OrderStatus } from '../domain/orderStatus.ts';
import type { UserRole } from '../http/context.ts';
import { tashkentDate } from '../domain/tashkentTime.ts';
import { isoSql } from '../http/serialize.ts';
import { getCart, type CartLineRecord } from './cart.ts';
import type { Unit } from './catalog.ts';

export const ORDER_STATUS_EVENT = 'order.status_changed';
/** Staff group alert (ADR 0015): new orders and the statuses the shop floor must react to. */
export const STAFF_ALERT_EVENT = 'order.staff_alert';
export const STAFF_ALERT_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'NEW',
  'CANCELLED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
]);
export const AUDIT_STATUS_CHANGE = 'order.status_change';
export const IDEMPOTENCY_CONSTRAINT = 'uq_orders_user_id_idempotency_key';
export const NUMBER_CONSTRAINT = 'uq_orders_number';
/** Crockford-style alphabet without look-alikes (0/O, 1/I/L, U). */
export const NUMBER_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const NUMBER_ATTEMPTS = 5;

export const PAYMENT_METHODS = ['cash_on_delivery', 'card_on_delivery'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// --- records -------------------------------------------------------------------------------------

export interface QuoteRecord {
  lines: CartLineRecord[];
  totals: QuoteTotals;
}

/** The validated delivery address; stored as the order's `address_snapshot` (JSONB) as is. */
export interface DeliveryAddressInput {
  /** WGS84, rounded to 6 decimals. */
  lat: number;
  lon: number;
  street: string;
  house: string;
  apartment: string | null;
  entrance: string | null;
  floor: string | null;
  landmark: string | null;
}

export interface NewOrder {
  address: DeliveryAddressInput;
  recipientName: string;
  recipientPhone: string;
  paymentMethod: PaymentMethod;
  comment: string | null;
  expectedTotalUzs: number;
}

export interface Actor {
  userId: string | null;
  role: UserRole;
}

export interface OrderItemRecord {
  product_id: string | null;
  sku: string;
  name_uz: string;
  name_ru: string;
  unit: Unit;
  unit_price_uzs: number;
  quantity: number;
  line_total_uzs: number;
}

export interface StatusChangeRecord {
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  actor_role: UserRole;
  reason: string | null;
  /** Pydantic-formatted UTC datetime. */
  created_at: string;
}

export interface OrderRecord {
  id: string;
  number: string;
  user_id: string;
  status: OrderStatus;
  subtotal_uzs: number;
  total_uzs: number;
  item_count: number;
  payment_method: PaymentMethod;
  recipient_name: string;
  recipient_phone: string;
  address: Record<string, unknown>;
  comment: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
  items: OrderItemRecord[];
  history: StatusChangeRecord[];
}

export interface OrderSummaryRecord {
  id: string;
  number: string;
  status: OrderStatus;
  total_uzs: number;
  item_count: number;
  created_at: string;
}

export interface OrderPageRecord {
  items: OrderSummaryRecord[];
  total: number;
}

export interface CreatedOrder {
  order: OrderRecord;
  /** True when an earlier request with the same Idempotency-Key created it. */
  replayed: boolean;
}

// --- pure helpers --------------------------------------------------------------------------------

export function lineFacts(lines: readonly CartLineRecord[]): LineFacts[] {
  return lines.map((line) => ({
    priceUzs: line.product.price_uzs,
    quantity: line.quantity,
    isAvailable: line.isAvailable,
    stockQuantity: line.product.stock_quantity,
  }));
}

/** `YYMMDD-XXXXXX`: the local (Asia/Tashkent) date plus 6 random characters. */
export function newOrderNumber(now: number, random: (max: number) => number = randomInt): string {
  let suffix = '';
  for (let i = 0; i < 6; i += 1) suffix += NUMBER_ALPHABET[random(NUMBER_ALPHABET.length)];
  const day = tashkentDate(now); // YYYY-MM-DD
  return `${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}-${suffix}`;
}

/** The error to refuse an order with, most actionable first. */
export function firstBlockingError(
  lines: readonly CartLineRecord[],
  totals: QuoteTotals,
): CheckoutError | null {
  for (const [index, line] of lines.entries()) {
    const issue = totals.lines[index]?.issue;
    if (issue === 'product_inactive') return new OrderProductUnavailableError(line.product.id);
    if (issue === 'insufficient_stock') {
      return new OrderInsufficientStockError(line.product.id, line.product.stock_quantity ?? 0);
    }
  }
  if (totals.issues.includes('cart_empty')) return new CartEmptyError();
  return null;
}

function constraintOf(error: unknown): string | null {
  const value = (error as { constraint?: unknown } | null)?.constraint;
  return typeof value === 'string' ? value : null;
}

function sameHash(stored: string, given: string): boolean {
  const a = Buffer.from(stored, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Internal: a concurrent request committed an order with this idempotency key first. */
class ReplayRace extends Error {}

// --- checkout ------------------------------------------------------------------------------------

export async function quote(db: Queryable, userId: string): Promise<QuoteRecord> {
  const cart = await getCart(db, userId);
  return { lines: cart.lines, totals: buildQuote(lineFacts(cart.lines)) };
}

export interface CreateOrderOptions {
  idempotencyKey: string;
  requestHash: string;
  now: number;
}

export async function createOrder(
  db: Database,
  userId: string,
  newOrder: NewOrder,
  options: CreateOrderOptions,
): Promise<CreatedOrder> {
  try {
    return await db.tx((client) => createOrderTx(client, userId, newOrder, options));
  } catch (error) {
    if (!(error instanceof ReplayRace)) throw error;
    // Lost the race to a concurrent request with the same key: that one is the order.
    return db.tx(async (client) => {
      const existing = await orderIdForKey(client, userId, options.idempotencyKey);
      if (existing === null) throw error; // the constraint said it exists
      return replay(client, existing, options.requestHash);
    });
  }
}

async function createOrderTx(
  client: pg.PoolClient,
  userId: string,
  newOrder: NewOrder,
  { idempotencyKey, requestHash, now }: CreateOrderOptions,
): Promise<CreatedOrder> {
  const locked = await client.query<{ id: string }>(
    'SELECT id::text AS id FROM carts WHERE user_id = $1 FOR UPDATE',
    [userId],
  );
  const cartId = locked.rows[0]?.id ?? null;

  const existing = await orderIdForKey(client, userId, idempotencyKey);
  if (existing !== null) return replay(client, existing, requestHash);
  if (cartId === null) throw new CartEmptyError();

  // Serialised by the cart lock, so concurrent requests cannot both slip under it.
  const open = await client.query<{ n: number }>(
    "SELECT count(*)::int8 AS n FROM orders WHERE user_id = $1 AND status = 'NEW'",
    [userId],
  );
  if ((open.rows[0]?.n ?? 0) >= MAX_OPEN_ORDERS) throw new TooManyOpenOrdersError();

  const productIds = await client.query<{ product_id: string }>(
    'SELECT product_id::text AS product_id FROM cart_items WHERE cart_id = $1',
    [cartId],
  );
  await lockProducts(
    client,
    productIds.rows.map((row) => row.product_id),
  );

  const cart = await getCart(client, userId);
  const totals = buildQuote(lineFacts(cart.lines));
  const blocking = firstBlockingError(cart.lines, totals);
  if (blocking !== null) throw blocking;
  if (totals.totalUzs !== newOrder.expectedTotalUzs) throw new PriceChangedError(totals.totalUzs);

  const orderId = await insertOrder(client, userId, newOrder, cart.lines, totals, {
    idempotencyKey,
    requestHash,
    now,
  });
  for (const line of cart.lines) {
    if (line.product.stock_quantity !== null) {
      await client.query(
        `UPDATE products SET stock_quantity = stock_quantity - $2, updated_at = now()
          WHERE id = $1`,
        [line.product.id, line.quantity],
      );
    }
  }
  await client.query('DELETE FROM cart_items WHERE cart_id = $1', [cartId]);
  await client.query('UPDATE carts SET updated_at = now() WHERE id = $1', [cartId]);
  await recordChange(client, orderId, {
    fromStatus: null,
    toStatus: 'NEW',
    actor: { userId, role: 'customer' },
    reason: null,
  });
  return { order: await loadOrder(client, orderId), replayed: false };
}

// --- customer reads / cancel ---------------------------------------------------------------------

export async function listForUser(
  db: Queryable,
  userId: string,
  page: number,
  pageSize: number,
): Promise<OrderPageRecord> {
  return orderPage(db, 'user_id = $1', [userId], page, pageSize);
}

/** The order if it exists AND belongs to `userId` (another customer's order looks missing). */
export async function getForUser(
  db: Queryable,
  userId: string,
  orderId: string,
): Promise<OrderRecord | null> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id::text AS id FROM orders WHERE id = $1 AND user_id = $2',
    [orderId, userId],
  );
  const owned = rows[0]?.id;
  return owned === undefined ? null : loadOrder(db, owned);
}

export async function cancelForUser(
  db: Database,
  userId: string,
  orderId: string,
  reason: string,
): Promise<OrderRecord> {
  return db.tx(async (client) => {
    const order = await lockOrder(client, orderId, userId);
    if (order === null) throw new OrderNotFoundError();
    if (!customerCanCancel(order.status)) throw new OrderNotCancellableError(order.status);
    await applyStatus(client, order, 'CANCELLED', { userId, role: 'customer' }, reason);
    return loadOrder(client, order.id);
  });
}

// --- operator / admin ----------------------------------------------------------------------------

export async function listAll(
  db: Queryable,
  status: OrderStatus | null,
  page: number,
  pageSize: number,
): Promise<OrderPageRecord> {
  return status === null
    ? orderPage(db, null, [], page, pageSize)
    : orderPage(db, 'status = $1::order_status', [status], page, pageSize);
}

export async function getOrder(db: Queryable, orderId: string): Promise<OrderRecord | null> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id::text AS id FROM orders WHERE id = $1',
    [orderId],
  );
  const found = rows[0]?.id;
  return found === undefined ? null : loadOrder(db, found);
}

export interface ChangeStatusOptions {
  actor: Actor;
  reason: string | null;
  expectedStatus: OrderStatus | null;
}

export async function changeStatus(
  db: Database,
  orderId: string,
  target: OrderStatus,
  { actor, reason, expectedStatus }: ChangeStatusOptions,
): Promise<OrderRecord> {
  return db.tx(async (client) => {
    const order = await lockOrder(client, orderId, null);
    if (order === null) throw new OrderNotFoundError();
    if (expectedStatus !== null && order.status !== expectedStatus) {
      throw new OrderStatusConflictError(order.status);
    }
    if (!canTransition(order.status, target, reason)) {
      throw new InvalidStatusTransitionError(order.status);
    }
    await applyStatus(client, order, target, actor, reason);
    return loadOrder(client, order.id);
  });
}

// --- internals -----------------------------------------------------------------------------------

async function orderIdForKey(db: Queryable, userId: string, key: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id::text AS id FROM orders WHERE user_id = $1 AND idempotency_key = $2',
    [userId, key],
  );
  return rows[0]?.id ?? null;
}

async function replay(db: Queryable, orderId: string, requestHash: string): Promise<CreatedOrder> {
  const { rows } = await db.query<{ hash: string }>(
    'SELECT idempotency_request_hash AS hash FROM orders WHERE id = $1',
    [orderId],
  );
  const stored = rows[0]?.hash;
  if (stored === undefined || !sameHash(stored, requestHash)) {
    throw new IdempotencyKeyConflictError();
  }
  return { order: await loadOrder(db, orderId), replayed: true };
}

async function lockProducts(db: Queryable, productIds: readonly string[]): Promise<void> {
  if (productIds.length === 0) return;
  await db.query('SELECT id FROM products WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [
    productIds,
  ]);
}

async function insertOrder(
  client: pg.PoolClient,
  userId: string,
  newOrder: NewOrder,
  lines: readonly CartLineRecord[],
  totals: QuoteTotals,
  options: { idempotencyKey: string; requestHash: string; now: number },
): Promise<string> {
  for (let attempt = 0; attempt < NUMBER_ATTEMPTS; attempt += 1) {
    await client.query('SAVEPOINT order_insert');
    let orderId: string;
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO orders (
           id, number, user_id, status, subtotal_uzs, total_uzs, item_count, payment_method,
           recipient_name, recipient_phone, address_snapshot, comment, idempotency_key,
           idempotency_request_hash)
         VALUES (gen_random_uuid(), $1, $2, 'NEW', $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11,
                 $12)
         RETURNING id::text AS id`,
        [
          newOrderNumber(options.now),
          userId,
          totals.subtotalUzs,
          totals.totalUzs,
          totals.cart.itemCount,
          newOrder.paymentMethod,
          newOrder.recipientName,
          newOrder.recipientPhone,
          JSON.stringify(newOrder.address),
          newOrder.comment,
          options.idempotencyKey,
          options.requestHash,
        ],
      );
      orderId = (rows[0] as { id: string }).id;
      await client.query('RELEASE SAVEPOINT order_insert');
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT order_insert');
      const constraint = constraintOf(error);
      if (constraint === IDEMPOTENCY_CONSTRAINT) throw new ReplayRace();
      if (constraint === NUMBER_CONSTRAINT) continue;
      throw error;
    }
    for (const line of lines) {
      await client.query(
        `INSERT INTO order_items (id, order_id, product_id, sku, name_uz, name_ru, unit,
                                  unit_price_uzs, quantity, line_total_uzs, stock_decremented)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          orderId,
          line.product.id,
          line.product.sku,
          line.product.name_uz,
          line.product.name_ru,
          line.product.unit,
          line.product.price_uzs,
          line.quantity,
          line.product.price_uzs * line.quantity,
          line.product.stock_quantity !== null,
        ],
      );
    }
    return orderId;
  }
  throw new Error('could not allocate a unique order number');
}

interface LockedOrder {
  id: string;
  number: string;
  status: OrderStatus;
}

async function lockOrder(
  db: Queryable,
  orderId: string,
  userId: string | null,
): Promise<LockedOrder | null> {
  const { rows } = await db.query<LockedOrder>(
    `SELECT id::text AS id, number, status::text AS status
       FROM orders
      WHERE id = $1 ${userId === null ? '' : 'AND user_id = $2'}
      FOR UPDATE`,
    userId === null ? [orderId] : [orderId, userId],
  );
  return rows[0] ?? null;
}

/** Move a locked order to `target` (already validated) and record everything. */
async function applyStatus(
  db: Queryable,
  order: LockedOrder,
  target: OrderStatus,
  actor: Actor,
  reason: string | null,
): Promise<void> {
  const previous = order.status;
  if (target === 'CANCELLED') {
    await restock(db, order.id);
    await db.query(
      `UPDATE orders SET status = $2::order_status, updated_at = now(), cancel_reason = $3
        WHERE id = $1`,
      [order.id, target, reason],
    );
  } else {
    await db.query(
      'UPDATE orders SET status = $2::order_status, updated_at = now() WHERE id = $1',
      [order.id, target],
    );
  }
  await recordChange(db, order.id, {
    fromStatus: previous,
    toStatus: target,
    actor,
    reason: target === 'CANCELLED' ? reason : null,
  });
  // The reason is free text (it may name people or places): only whether there was one.
  await recordAudit(db, actor, {
    action: AUDIT_STATUS_CHANGE,
    entityType: AuditEntity.ORDER,
    entityId: order.id,
    changes: { status: [previous, target] },
    extra: { order_number: order.number, has_reason: reason !== null && reason !== '' },
  });
}

/** Return what this order actually took (a product tracked later gains nothing). */
async function restock(db: Queryable, orderId: string): Promise<void> {
  const { rows } = await db.query<{ product_id: string; quantity: number }>(
    `SELECT product_id::text AS product_id, sum(quantity)::int8 AS quantity
       FROM order_items
      WHERE order_id = $1 AND product_id IS NOT NULL AND stock_decremented
      GROUP BY product_id
      ORDER BY product_id`,
    [orderId],
  );
  await lockProducts(
    db,
    rows.map((row) => row.product_id),
  );
  for (const row of rows) {
    await db.query(
      `UPDATE products SET stock_quantity = stock_quantity + $2, updated_at = now()
        WHERE id = $1 AND stock_quantity IS NOT NULL`,
      [row.product_id, row.quantity],
    );
  }
}

async function recordChange(
  db: Queryable,
  orderId: string,
  change: {
    fromStatus: OrderStatus | null;
    toStatus: OrderStatus;
    actor: Actor;
    reason: string | null;
  },
): Promise<void> {
  const { fromStatus, toStatus, actor, reason } = change;
  await db.query(
    `INSERT INTO order_status_history (id, order_id, from_status, to_status, actor_user_id,
                                       actor_role, reason, created_at)
     VALUES (gen_random_uuid(), $1, $2::order_status, $3::order_status, $4, $5::user_role, $6,
             clock_timestamp())`,
    [orderId, fromStatus, toStatus, actor.userId, actor.role, reason],
  );
  const { rows } = await db.query<{
    number: string;
    total_uzs: number;
    telegram_user_id: number;
    language: string;
    address: Record<string, unknown>;
  }>(
    `SELECT o.number, o.total_uzs, u.telegram_user_id, u.language::text AS language,
            o.address_snapshot AS address
       FROM orders o JOIN users u ON u.id = o.user_id
      WHERE o.id = $1`,
    [orderId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('order vanished inside its transaction');
  const payload: Record<string, unknown> = {
    order_id: orderId,
    order_number: row.number,
    status: toStatus,
    locale: row.language,
    total_uzs: row.total_uzs,
    chat_id: row.telegram_user_id,
  };
  if (toStatus === 'CANCELLED' && reason) payload['cancel_reason'] = reason;
  await insertOutbox(db, ORDER_STATUS_EVENT, orderId, payload);

  if (STAFF_ALERT_STATUSES.has(toStatus)) {
    const staff = await db.query<{ chat_id: number }>(
      'SELECT chat_id FROM staff_notification_chat LIMIT 1',
    );
    const groupChatId = staff.rows[0]?.chat_id;
    if (groupChatId !== undefined) {
      // Same transaction as the change: an alert exists iff the change committed. No customer
      // name, phone or address text: staff open the order in the admin. The one exception: a NEW
      // order's destination coordinates, which reach the group only inside the Yandex Go courier
      // button URL (services/telegram/tgcloud/lib/notifications/yandexGo.js), never as text.
      const alert: Record<string, unknown> = {
        order_id: orderId,
        order_number: row.number,
        status: toStatus,
        previous_status: fromStatus,
        total_uzs: row.total_uzs,
        chat_id: groupChatId,
        cancelled_by_customer: toStatus === 'CANCELLED' && actor.role === 'customer',
      };
      const destination = toStatus === 'NEW' ? coordinatesOf(row.address) : null;
      if (destination !== null) alert['destination'] = destination;
      await insertOutbox(db, STAFF_ALERT_EVENT, orderId, alert);
    }
  }
}

function coordinate(value: unknown, limit: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= -limit && value <= limit
    ? value
    : null;
}

/**
 * The map point of a stored `address_snapshot` (port of `snapshot_point` in
 * services/api/app/domain/geo.py), or `null` when it has no valid coordinates: orders placed
 * before courier delivery have none (their old address keys are ignored).
 */
export function coordinatesOf(
  snapshot: Readonly<Record<string, unknown>>,
): { lat: number; lon: number } | null {
  const lat = coordinate(snapshot['lat'], 90);
  const lon = coordinate(snapshot['lon'], 180);
  return lat === null || lon === null ? null : { lat, lon };
}

async function insertOutbox(
  db: Queryable,
  eventType: string,
  orderId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO notification_outbox (id, event_type, order_id, payload)
     VALUES (gen_random_uuid(), $1, $2, $3::jsonb)`,
    [eventType, orderId, JSON.stringify(payload)],
  );
}

async function orderPage(
  db: Queryable,
  condition: string | null,
  params: readonly unknown[],
  page: number,
  pageSize: number,
): Promise<OrderPageRecord> {
  const where = condition === null ? '' : `WHERE ${condition}`;
  const counted = await db.query<{ total: number }>(
    `SELECT count(*)::int8 AS total FROM orders ${where}`,
    [...params],
  );
  const total = counted.rows[0]?.total ?? 0;
  const offset = (page - 1) * pageSize;
  if (offset >= total) return { items: [], total };
  const n = params.length;
  const { rows } = await db.query<OrderSummaryRecord>(
    `SELECT id::text AS id, number, status::text AS status, total_uzs, item_count,
            ${isoSql('created_at')} AS created_at
       FROM orders ${where}
      ORDER BY orders.created_at DESC, orders.id DESC
      LIMIT $${n + 1} OFFSET $${n + 2}`,
    [...params, pageSize, offset],
  );
  return { items: rows, total };
}

export async function loadOrder(db: Queryable, orderId: string): Promise<OrderRecord> {
  const found = await db.query<Omit<OrderRecord, 'items' | 'history'>>(
    `SELECT id::text AS id, number, user_id::text AS user_id, status::text AS status,
            subtotal_uzs, total_uzs, item_count, payment_method::text AS payment_method,
            recipient_name, recipient_phone, address_snapshot AS address, comment, cancel_reason,
            ${isoSql('created_at')} AS created_at, ${isoSql('updated_at')} AS updated_at
       FROM orders WHERE id = $1`,
    [orderId],
  );
  const order = found.rows[0];
  if (order === undefined) throw new Error('order not found');
  const items = await db.query<OrderItemRecord>(
    `SELECT product_id::text AS product_id, sku, name_uz, name_ru, unit::text AS unit,
            unit_price_uzs, quantity, line_total_uzs
       FROM order_items WHERE order_id = $1
      ORDER BY name_uz, id`,
    [orderId],
  );
  const history = await db.query<StatusChangeRecord>(
    `SELECT from_status::text AS from_status, to_status::text AS to_status,
            actor_role::text AS actor_role, reason, ${isoSql('created_at')} AS created_at
       FROM order_status_history WHERE order_id = $1
      ORDER BY order_status_history.created_at, id`,
    [orderId],
  );
  return { ...order, items: items.rows, history: history.rows };
}
