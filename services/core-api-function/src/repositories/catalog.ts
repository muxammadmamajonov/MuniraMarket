/**
 * Public catalog reads (port of services/api/app/repositories/catalog.py).
 *
 * Visibility rule used everywhere: a category is *visible* when it and every ancestor is active; a
 * product is *visible* when it is active and its category is visible. An inactive category
 * therefore hides its whole subtree and all products in it.
 */
import type { Queryable } from '../db.ts';

export const PRODUCT_SORTS = ['newest', 'price_asc', 'price_desc', 'name'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

export const UNITS = ['piece', 'kg', 'g', 'l', 'ml'] as const;
export type Unit = (typeof UNITS)[number];

/** Unknown slug, or the category (or one of its ancestors) is inactive. */
export class CategoryNotFoundError extends Error {
  constructor() {
    super('category not found');
    this.name = 'CategoryNotFoundError';
  }
}

export interface CategoryNodeRecord {
  id: string;
  slug: string;
  name_uz: string;
  name_ru: string;
  image_url: string | null;
  sort_order: number;
  children: CategoryNodeRecord[];
}

export interface CategoryRefRecord {
  id: string;
  slug: string;
  name_uz: string;
  name_ru: string;
}

export interface ProductSummaryRecord {
  id: string;
  slug: string;
  sku: string;
  name_uz: string;
  name_ru: string;
  unit: Unit;
  price_uzs: number;
  old_price_uzs: number | null;
  stock_quantity: number | null;
  image_url: string | null;
  category_id: string;
}

export interface ProductDetailRecord {
  summary: ProductSummaryRecord;
  description_uz: string | null;
  description_ru: string | null;
  brand: string | null;
  category: CategoryRefRecord;
}

export interface ProductPageRecord {
  items: ProductSummaryRecord[];
  total: number;
}

// --- pure helpers --------------------------------------------------------------------------------

/** Escape backslash, `%` and `_` so input matches literally under `ESCAPE '\'`. */
export function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export interface CategoryRow {
  id: string;
  parent_id: string | null;
  slug: string;
  name_uz: string;
  name_ru: string;
  image_url: string | null;
  sort_order: number;
}

/**
 * Nest already-ordered rows under their parents, keeping the given order at every level. Rows
 * whose parent is not part of `rows` are dropped (they are not reachable from a root).
 */
export function buildCategoryTree(rows: readonly CategoryRow[]): CategoryNodeRecord[] {
  const byParent = new Map<string | null, CategoryRow[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.parent_id);
    if (siblings) siblings.push(row);
    else byParent.set(row.parent_id, [row]);
  }
  const nodes = (parentId: string | null): CategoryNodeRecord[] =>
    (byParent.get(parentId) ?? []).map((row) => ({
      id: row.id,
      slug: row.slug,
      name_uz: row.name_uz,
      name_ru: row.name_ru,
      image_url: row.image_url,
      sort_order: row.sort_order,
      children: nodes(row.id),
    }));
  return nodes(null);
}

export function totalPages(total: number, pageSize: number): number {
  return Math.ceil(total / pageSize);
}

// --- SQL building blocks (shared with the cart and order repositories) ---------------------------

/**
 * `WITH RECURSIVE visible_category(id, parent_id, slug)`: categories that are active with all
 * ancestors active (walked from the roots down). Prefix a statement with it.
 */
export const VISIBLE_CATEGORY_CTE = `visible_category AS (
    SELECT c.id, c.parent_id, c.slug FROM categories c
     WHERE c.parent_id IS NULL AND c.is_active
    UNION ALL
    SELECT c.id, c.parent_id, c.slug FROM categories c
      JOIN visible_category v ON c.parent_id = v.id
     WHERE c.is_active
  )`;

/** Boolean SQL: product `alias` is visible (needs `VISIBLE_CATEGORY_CTE`). */
export function productIsVisible(alias = 'p'): string {
  return `(${alias}.is_active AND ${alias}.category_id IN (SELECT id FROM visible_category))`;
}

/**
 * SQL twin of `sellableQuantity` (ADR 0018): `NULL` while stock is not tracked, else
 * `stock_quantity - safety_stock`, never below 0.
 */
export function sellableStockSql(alias = 'p'): string {
  return (
    `(CASE WHEN ${alias}.stock_quantity IS NULL THEN NULL ` +
    `ELSE GREATEST(${alias}.stock_quantity - ${alias}.safety_stock, 0) END)`
  );
}

/**
 * Columns of `ProductSummaryRecord` for product alias `alias`. `stock_quantity` is the SELLABLE
 * quantity (`sellableStockSql`), never the physical stock: the storefront sells, shows and
 * validates against what is left after the safety stock.
 */
export function productSummaryColumns(alias = 'p'): string {
  return [
    `${alias}.id::text AS id`,
    `${alias}.slug`,
    `${alias}.sku`,
    `${alias}.name_uz`,
    `${alias}.name_ru`,
    `${alias}.unit::text AS unit`,
    `${alias}.price_uzs`,
    `${alias}.old_price_uzs`,
    `${sellableStockSql(alias)} AS stock_quantity`,
    `${alias}.image_url`,
    `${alias}.category_id::text AS category_id`,
  ].join(', ');
}

/** Build a record from any row selecting `productSummaryColumns()`. */
export function summaryFromRow(row: Record<string, unknown>): ProductSummaryRecord {
  return {
    id: row['id'] as string,
    slug: row['slug'] as string,
    sku: row['sku'] as string,
    name_uz: row['name_uz'] as string,
    name_ru: row['name_ru'] as string,
    unit: row['unit'] as Unit,
    price_uzs: row['price_uzs'] as number,
    old_price_uzs: row['old_price_uzs'] as number | null,
    stock_quantity: row['stock_quantity'] as number | null,
    image_url: row['image_url'] as string | null,
    category_id: row['category_id'] as string,
  };
}

/** Every ordering ends with `id` so pages never overlap or skip equal-keyed rows. */
const ORDER_BY: Readonly<Record<ProductSort, string>> = {
  newest: 'p.created_at DESC, p.id DESC',
  price_asc: 'p.price_uzs ASC, p.id ASC',
  price_desc: 'p.price_uzs DESC, p.id ASC',
  name: 'p.name_uz ASC, p.id ASC',
};

// --- queries -------------------------------------------------------------------------------------

export async function listCategoryTree(db: Queryable): Promise<CategoryNodeRecord[]> {
  const { rows } = await db.query<CategoryRow>(
    `WITH RECURSIVE ${VISIBLE_CATEGORY_CTE}
     SELECT c.id::text AS id, c.parent_id::text AS parent_id, c.slug, c.name_uz, c.name_ru,
            c.image_url, c.sort_order
       FROM categories c JOIN visible_category v ON v.id = c.id
      ORDER BY c.sort_order, c.name_uz, c.id`,
  );
  return buildCategoryTree(rows);
}

export interface ListProductsOptions {
  categorySlug: string | null;
  query: string | null;
  inStockOnly: boolean;
  sort: ProductSort;
  page: number;
  pageSize: number;
}

/**
 * Active products in visible categories, with stable pagination. Throws `CategoryNotFoundError`
 * for an unknown or hidden `categorySlug`. `inStockOnly` keeps untracked products
 * (`stock_quantity IS NULL`) and tracked ones with sellable stock left (above the safety stock),
 * the same rule as `isInStock`.
 */
export async function listProducts(
  db: Queryable,
  options: ListProductsOptions,
): Promise<ProductPageRecord> {
  const params: unknown[] = [];
  const conditions = ['p.is_active'];
  let ctes = VISIBLE_CATEGORY_CTE;

  if (options.categorySlug === null) {
    conditions.push('p.category_id IN (SELECT id FROM visible_category)');
  } else {
    const found = await db.query<{ id: string }>(
      `WITH RECURSIVE ${VISIBLE_CATEGORY_CTE}
       SELECT id::text AS id FROM visible_category WHERE slug = $1`,
      [options.categorySlug],
    );
    const categoryId = found.rows[0]?.id;
    if (categoryId === undefined) throw new CategoryNotFoundError();
    params.push(categoryId);
    // The category and all of its visible descendants (a recursive walk over `visible`).
    ctes += `, subtree AS (
        SELECT v.id FROM visible_category v WHERE v.id = $${params.length}::uuid
        UNION ALL
        SELECT v.id FROM visible_category v JOIN subtree s ON v.parent_id = s.id
      )`;
    conditions.push('p.category_id IN (SELECT id FROM subtree)');
  }

  if (options.query !== null) {
    params.push(`%${escapeLike(options.query)}%`);
    const n = params.length;
    conditions.push(
      `(p.name_uz ILIKE $${n} ESCAPE '\\' OR p.name_ru ILIKE $${n} ESCAPE '\\' ` +
        `OR p.sku ILIKE $${n} ESCAPE '\\')`,
    );
  }
  if (options.inStockOnly) {
    conditions.push('(p.stock_quantity IS NULL OR p.stock_quantity > p.safety_stock)');
  }

  const where = conditions.join(' AND ');
  const counted = await db.query<{ total: number }>(
    `WITH RECURSIVE ${ctes} SELECT count(*)::int8 AS total FROM products p WHERE ${where}`,
    params,
  );
  const total = counted.rows[0]?.total ?? 0;
  const offset = (options.page - 1) * options.pageSize;
  if (offset >= total) return { items: [], total };

  const limitParam = params.length + 1;
  const { rows } = await db.query(
    `WITH RECURSIVE ${ctes}
     SELECT ${productSummaryColumns()} FROM products p WHERE ${where}
      ORDER BY ${ORDER_BY[options.sort]}
      LIMIT $${limitParam} OFFSET $${limitParam + 1}`,
    [...params, options.pageSize, offset],
  );
  return { items: rows.map(summaryFromRow), total };
}

/** One visible product, or `null` (missing, inactive, or in a hidden category). */
export async function getProductBySlug(
  db: Queryable,
  slug: string,
): Promise<ProductDetailRecord | null> {
  const { rows } = await db.query(
    `WITH RECURSIVE ${VISIBLE_CATEGORY_CTE}
     SELECT ${productSummaryColumns()}, p.description_uz, p.description_ru, p.brand,
            c.slug AS category_slug, c.name_uz AS category_name_uz, c.name_ru AS category_name_ru
       FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.slug = $1 AND ${productIsVisible()}
      LIMIT 1`,
    [slug],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const summary = summaryFromRow(row);
  return {
    summary,
    description_uz: row['description_uz'] as string | null,
    description_ru: row['description_ru'] as string | null,
    brand: row['brand'] as string | null,
    category: {
      id: summary.category_id,
      slug: row['category_slug'] as string,
      name_uz: row['category_name_uz'] as string,
      name_ru: row['category_name_ru'] as string,
    },
  };
}
