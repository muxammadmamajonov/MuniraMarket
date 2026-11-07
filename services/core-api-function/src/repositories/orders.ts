/**
 * Checkout, orders and the order lifecycle (port of services/api/app/repositories/orders.py).
 *
 * Locking (every write is ONE `db.tx`; locks are always taken in this order, so concurrent writers
 * cannot deadlock):
 * 1. the customer's `carts` row (order creation) or the `orders` row (status changes),
 * 2. the affected `products` rows, `FOR UPDATE` in ascending id order,
 * 3. the booked `delivery_slots` row (one conditional `UPDATE`; admin edits lock it the same way,
 *    so an order and a capacity change on one slot serialise on that row).
 *
 * Order creation, under those locks: replay an earlier order with the same `Idempotency-Key`;
 * re-evaluate the cart against current prices, visibility and stock with the same pure function
 * as the quote; refuse unless the cart is clean, the zone serves the district, the minimum order
 * is met and the total equals what the customer was shown; then book the slot, decrement tracked
 * stock (bumping `products.updated_at` like the ORM's `onupdate`), snapshot the lines, write the
 * status history and the notification outbox rows, and empty the cart.
 *
 * Cancelling (by the customer, or an operator) returns tracked stock and the slot's place, and
 * writes an `order.status_change` audit row (no reason text, no recipient data); so does every
 * other status change. Nothing is ever committed partially: any rule violation rolls the whole
 * transaction back.
 */
import { randomInt, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { AuditEntity, recordAudit } from '../audit.ts';
import type { Database, Queryable } from '../db.ts';
import type { LineFacts } from '../domain/cart.ts';
import {
  BelowMinimumOrderError,
  CartEmptyError,
  DistrictNotServedError,
  IdempotencyKeyConflictError,
  InvalidStatusTransitionError,
  MAX_OPEN_ORDERS,
  OrderInsufficientStockError,
  OrderNotCancellableError,
  OrderNotFoundError,
  OrderProductUnavailableError,
  OrderStatusConflictError,
  PriceChangedError,
  SlotFullError,
  SlotRequiredError,
  SlotUnavailableError,
  TooManyOpenOrdersError,
  buildQuote,
  type CheckoutError,
  type QuoteTotals,
} from '../domain/checkout.ts';
import { tashkentDate } from '../domain/delivery.ts';
import { canTransition, customerCanCancel, type OrderStatus } from '../domain/orderStatus.ts';
import type { UserRole } from '../http/context.ts';
import { isoDateSql, isoSql } from '../http/serialize.ts';
import { getCart, type CartLineRecord } from './cart.ts';
import type { Unit } from './catalog.ts';
import {
  bookableParams,
  bookableSlot,
  findZoneForDistrict,
  hasBookableSlot,
  offeredSlots,
  type SlotOptionRecord,
  type ZoneRecord,
} from './delivery.ts';

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
  zone: ZoneRecord;
  lines: CartLineRecord[];
  totals: QuoteTotals;
  /** The zone runs on delivery slots: an order must name one of them. */
  slotRequired: boolean;
  slots: SlotOptionRecord[];
}

export interface DeliveryAddressInput {
  district: string;
  street: string;
  house: string;
  apartment: string | null;
  entrance: string | null;
  floor: string | null;
  landmark: string | null;
}

export interface NewOrder {
  district: string;
  /** Structured address; stored as the order's `address_snapshot` (`district` included). */
  address: DeliveryAddressInput;
  recipientName: string;
  recipientPhone: string;
  paymentMethod: PaymentMethod;
  comment: string | null;
  expectedTotalUzs: number;
  deliverySlotId: string | null;
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

/** The booked delivery window as it was when the order was placed. */
export interface SlotSnapshotRecord {
  slot_date: string;
  starts_at: string;
  ends_at: string;
}

export interface OrderRecord {
  id: string;
  number: string;
  user_id: string;
  status: OrderStatus;
  subtotal_uzs: number;
  delivery_fee_uzs: number;
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
  delivery_slot: SlotSnapshotRecord | null;
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
  if (totals.issues.includes('below_min_order')) return new BelowMinimumOrderError();
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

export async function quote(
  db: Queryable,
  userId: string,
  district: string,
  now: number,
): Promise<QuoteRecord> {
  const zone = await findZoneForDistrict(db, district);
  if (zone === null) throw new DistrictNotServedError();
  const cart = await getCart(db, userId);
  return {
    zone,
    lines: cart.lines,
    totals: buildQuote(lineFacts(cart.lines), zone.rules),
    slotRequired: await hasBookableSlot(db, zone.zoneId, now),
    slots: await offeredSlots(db, zone.zoneId, now),
  };
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

  const zone = await findZoneForDistrict(client, newOrder.district);
  if (zone === null) throw new DistrictNotServedError();
  const cart = await getCart(client, userId);
  const totals = buildQuote(lineFacts(cart.lines), zone.rules);
  const blocking = firstBlockingError(cart.lines, totals);
  if (blocking !== null) throw blocking;
  if (totals.totalUzs !== newOrder.expectedTotalUzs) throw new PriceChangedError(totals.totalUzs);
  // Last lock of the transaction (after the products): the slot row.
  const slot = await reserveSlot(client, zone.zoneId, newOrder.deliverySlotId, now);

  const orderId = await insertOrder(client, userId, newOrder, zone, cart.lines, totals, {
    slot,
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

/**
 * Book one place in `slotId` (or check that the zone needs none). One conditional `UPDATE`:
 * concurrent orders queue on the row lock and each re-checks `reserved_count < capacity` against
 * the committed count, so the slot is never oversold.
 */
async function reserveSlot(
  db: Queryable,
  zoneId: string,
  slotId: string | null,
  now: number,
): Promise<SlotSnapshotRecord | null> {
  if (slotId === null) {
    if (await hasBookableSlot(db, zoneId, now)) throw new SlotRequiredError();
    return null;
  }
  const booked = await db.query<SlotSnapshotRecord>(
    `UPDATE delivery_slots s
        SET reserved_count = s.reserved_count + 1, updated_at = now()
      WHERE s.id = $1 AND s.zone_id = $2 AND ${bookableSlot(3, 4)}
        AND s.reserved_count < s.capacity
     RETURNING ${isoDateSql('s.slot_date')} AS slot_date, s.starts_at::text AS starts_at,
               s.ends_at::text AS ends_at`,
    [slotId, zoneId, ...bookableParams(now)],
  );
  const row = booked.rows[0];
  if (row !== undefined) return row;
  // Nothing booked: say why. Only "full" is worth a different message to the customer.
  const found = await db.query<{ zone_id: string; bookable: boolean }>(
    `SELECT s.zone_id::text AS zone_id, ${bookableSlot(2, 3)} AS bookable
       FROM delivery_slots s WHERE s.id = $1`,
    [slotId, ...bookableParams(now)],
  );
  const slot = found.rows[0];
  if (slot === undefined || slot.zone_id !== zoneId || !slot.bookable) {
    throw new SlotUnavailableError();
  }
  throw new SlotFullError();
}

/** Give a cancelled order's place back (never below zero). */
async function releaseSlot(db: Queryable, slotId: string): Promise<void> {
  await db.query(
    `UPDATE delivery_slots SET reserved_count = reserved_count - 1, updated_at = now()
      WHERE id = $1 AND reserved_count > 0`,
    [slotId],
  );
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
  zone: ZoneRecord,
  lines: readonly CartLineRecord[],
  totals: QuoteTotals,
  options: {
    slot: SlotSnapshotRecord | null;
    idempotencyKey: string;
    requestHash: string;
    now: number;
  },
): Promise<string> {
  const { slot } = options;
  for (let attempt = 0; attempt < NUMBER_ATTEMPTS; attempt += 1) {
    await client.query('SAVEPOINT order_insert');
    let orderId: string;
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO orders (
           id, number, user_id, status, subtotal_uzs, delivery_fee_uzs, total_uzs, item_count,
           payment_method, delivery_zone_id, delivery_slot_id, delivery_slot_date,
           delivery_slot_starts_at, delivery_slot_ends_at, recipient_name, recipient_phone,
           address_snapshot, comment, idempotency_key, idempotency_request_hash)
         VALUES (gen_random_uuid(), $1, $2, 'NEW', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15::jsonb, $16, $17, $18)
         RETURNING id::text AS id`,
        [
          newOrderNumber(options.now),
          userId,
          totals.subtotalUzs,
          totals.deliveryFeeUzs,
          totals.totalUzs,
          totals.cart.itemCount,
          newOrder.paymentMethod,
          zone.zoneId,
          slot !== null ? newOrder.deliverySlotId : null,
          slot?.slot_date ?? null,
          slot?.starts_at ?? null,
          slot?.ends_at ?? null,
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
  delivery_slot_id: string | null;
}

async function lockOrder(
  db: Queryable,
  orderId: string,
  userId: string | null,
): Promise<LockedOrder | null> {
  const { rows } = await db.query<LockedOrder>(
    `SELECT id::text AS id, number, status::text AS status,
            delivery_slot_id::text AS delivery_slot_id
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
    if (order.delivery_slot_id !== null) await releaseSlot(db, order.delivery_slot_id);
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
  }>(
    `SELECT o.number, o.total_uzs, u.telegram_user_id, u.language::text AS language
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
      // name, address or phone: staff open the order in the admin.
      await insertOutbox(db, STAFF_ALERT_EVENT, orderId, {
        order_id: orderId,
        order_number: row.number,
        status: toStatus,
        previous_status: fromStatus,
        total_uzs: row.total_uzs,
        chat_id: groupChatId,
        cancelled_by_customer: toStatus === 'CANCELLED' && actor.role === 'customer',
      });
    }
  }
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
  const found = await db.query<
    Omit<OrderRecord, 'items' | 'history' | 'delivery_slot' | 'address'> & {
      address: Record<string, unknown>;
      slot_date: string | null;
      slot_starts_at: string | null;
      slot_ends_at: string | null;
    }
  >(
    `SELECT id::text AS id, number, user_id::text AS user_id, status::text AS status,
            subtotal_uzs, delivery_fee_uzs, total_uzs, item_count,
            payment_method::text AS payment_method, recipient_name, recipient_phone,
            address_snapshot AS address, comment, cancel_reason,
            ${isoSql('created_at')} AS created_at, ${isoSql('updated_at')} AS updated_at,
            ${isoDateSql('delivery_slot_date')} AS slot_date,
            delivery_slot_starts_at::text AS slot_starts_at,
            delivery_slot_ends_at::text AS slot_ends_at
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
  const { slot_date, slot_starts_at, slot_ends_at, ...rest } = order;
  return {
    ...rest,
    items: items.rows,
    history: history.rows,
    delivery_slot:
      slot_date !== null && slot_starts_at !== null && slot_ends_at !== null
        ? { slot_date, starts_at: slot_starts_at, ends_at: slot_ends_at }
        : null,
  };
}
