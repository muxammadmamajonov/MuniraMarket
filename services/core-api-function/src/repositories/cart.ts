/**
 * Cart persistence (port of services/api/app/repositories/cart.py).
 *
 * Every write is one transaction:
 * 1. `INSERT ... ON CONFLICT DO NOTHING` the user's cart (get-or-create without a race),
 * 2. `SELECT ... FOR UPDATE` the cart row, which serialises all concurrent writes of that user,
 * 3. validate against the current product row (active, stock, limits) and upsert the line with
 *    `ON CONFLICT (cart_id, product_id)`,
 * 4. bump `carts.updated_at` and commit.
 *
 * The cart never reserves stock; checkout re-validates. Rule violations are thrown as the domain
 * errors from src/domain/cart.ts.
 */
import type { Database, Queryable } from '../db.ts';
import {
  CartItemNotFoundError,
  ProductInactiveError,
  ProductNotFoundError,
  checkCanAddLine,
  checkLineQuantity,
} from '../domain/cart.ts';
import {
  VISIBLE_CATEGORY_CTE,
  productIsVisible,
  productSummaryColumns,
  sellableStockSql,
  summaryFromRow,
  type ProductSummaryRecord,
} from './catalog.ts';

export const CART_ITEMS_UNIQUE = 'uq_cart_items_cart_id_product_id';

export interface CartLineRecord {
  product: ProductSummaryRecord;
  quantity: number;
  /** Product active and its whole category chain active. */
  isAvailable: boolean;
}

export interface CartRecord {
  lines: CartLineRecord[];
}

/** Reading never creates a cart. */
export async function getCart(db: Queryable, userId: string): Promise<CartRecord> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id::text AS id FROM carts WHERE user_id = $1',
    [userId],
  );
  const cartId = rows[0]?.id;
  return cartId === undefined ? { lines: [] } : loadCart(db, cartId);
}

export async function addItem(
  db: Database,
  userId: string,
  productId: string,
  quantity: number,
): Promise<CartRecord> {
  return db.tx(async (client) => {
    const cartId = await lockOrCreateCart(client, userId);
    const facts = await productFacts(client, productId);
    if (facts === null) throw new ProductNotFoundError();
    if (!facts.isAvailable) throw new ProductInactiveError();

    const existing = await client.query<{ quantity: number }>(
      'SELECT quantity FROM cart_items WHERE cart_id = $1 AND product_id = $2',
      [cartId, productId],
    );
    const current = existing.rows[0]?.quantity;
    if (current === undefined) {
      const counted = await client.query<{ n: number }>(
        'SELECT count(*)::int8 AS n FROM cart_items WHERE cart_id = $1',
        [cartId],
      );
      checkCanAddLine(counted.rows[0]?.n ?? 0);
    }
    const newQuantity = (current ?? 0) + quantity;
    checkLineQuantity(newQuantity, facts.stockQuantity);

    // Wall-clock time (not the transaction start) so lines sort by when they were added.
    await client.query(
      `INSERT INTO cart_items (id, cart_id, product_id, quantity, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, clock_timestamp())
       ON CONFLICT ON CONSTRAINT ${CART_ITEMS_UNIQUE}
       DO UPDATE SET quantity = excluded.quantity`,
      [cartId, productId, newQuantity],
    );
    await touch(client, cartId);
    return loadCart(client, cartId);
  });
}

export async function setItemQuantity(
  db: Database,
  userId: string,
  productId: string,
  quantity: number,
): Promise<CartRecord> {
  return db.tx(async (client) => {
    const cartId = await lockExistingCart(client, userId);
    if (cartId === null) throw new CartItemNotFoundError();
    const line = await client.query<{ id: string }>(
      'SELECT id::text AS id FROM cart_items WHERE cart_id = $1 AND product_id = $2',
      [cartId, productId],
    );
    const lineId = line.rows[0]?.id;
    if (lineId === undefined) throw new CartItemNotFoundError();

    const facts = await productFacts(client, productId);
    if (facts === null) throw new ProductNotFoundError(); // the FK guarantees the product exists
    if (!facts.isAvailable) throw new ProductInactiveError();
    checkLineQuantity(quantity, facts.stockQuantity);

    await client.query('UPDATE cart_items SET quantity = $2 WHERE id = $1', [lineId, quantity]);
    await touch(client, cartId);
    return loadCart(client, cartId);
  });
}

/** Idempotent: removing a missing line still returns the cart. */
export async function removeItem(
  db: Database,
  userId: string,
  productId: string,
): Promise<CartRecord> {
  return db.tx(async (client) => {
    const cartId = await lockExistingCart(client, userId);
    if (cartId === null) return { lines: [] };
    const deleted = await client.query(
      'DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2 RETURNING id',
      [cartId, productId],
    );
    if ((deleted.rowCount ?? 0) > 0) await touch(client, cartId);
    return loadCart(client, cartId);
  });
}

// --- internals (also used by the order repository) ----------------------------------------------

async function lockOrCreateCart(db: Queryable, userId: string): Promise<string> {
  await db.query(
    `INSERT INTO carts (id, user_id) VALUES (gen_random_uuid(), $1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  const cartId = await lockExistingCart(db, userId);
  if (cartId === null) throw new Error('cart row missing after get-or-create');
  return cartId;
}

export async function lockExistingCart(db: Queryable, userId: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id::text AS id FROM carts WHERE user_id = $1 FOR UPDATE',
    [userId],
  );
  return rows[0]?.id ?? null;
}

async function productFacts(
  db: Queryable,
  productId: string,
): Promise<{ isAvailable: boolean; stockQuantity: number | null } | null> {
  const { rows } = await db.query<{ stock_quantity: number | null; is_available: boolean }>(
    `WITH RECURSIVE ${VISIBLE_CATEGORY_CTE}
     SELECT ${sellableStockSql()} AS stock_quantity, ${productIsVisible()} AS is_available
       FROM products p WHERE p.id = $1`,
    [productId],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : { isAvailable: row.is_available, stockQuantity: row.stock_quantity };
}

export async function touch(db: Queryable, cartId: string): Promise<void> {
  await db.query('UPDATE carts SET updated_at = now() WHERE id = $1', [cartId]);
}

/** The cart's lines in the order they were added, with current product facts. */
export async function loadCart(db: Queryable, cartId: string): Promise<CartRecord> {
  const { rows } = await db.query(
    `WITH RECURSIVE ${VISIBLE_CATEGORY_CTE}
     SELECT ${productSummaryColumns()}, ci.quantity AS line_quantity,
            ${productIsVisible()} AS is_available
       FROM cart_items ci JOIN products p ON p.id = ci.product_id
      WHERE ci.cart_id = $1
      ORDER BY ci.created_at, ci.id`,
    [cartId],
  );
  return {
    lines: rows.map((row) => ({
      product: summaryFromRow(row),
      quantity: row['line_quantity'] as number,
      isAvailable: row['is_available'] as boolean,
    })),
  };
}
