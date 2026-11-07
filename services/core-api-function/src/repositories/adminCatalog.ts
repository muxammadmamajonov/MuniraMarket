/**
 * Admin catalog writes (categories, products, CSV import/export); port of
 * services/api/app/repositories/admin_catalog.py.
 *
 * Every write is one transaction that also inserts its `audit_log` row(s), so a change and its
 * audit record commit or roll back together. Uniqueness (SKU, slugs) is enforced by the database
 * constraints; a violation is mapped to a typed error instead of being pre-checked.
 *
 * Locking (same as the reference):
 * - product update/archive/restore: the product row `FOR UPDATE`;
 * - category parent change: a transaction-level advisory lock serialises every re-parenting,
 *   then the category row `FOR UPDATE`;
 * - CSV import: the products named in the file `FOR UPDATE` in ascending id order, then the
 *   snapshot is read and re-validated under those locks (including `stale_row`).
 */

import type pg from 'pg';
import {
  AuditEntity,
  diffFields,
  recordAudit,
  type AuditActor,
  type AuditValue,
  type FieldChanges,
} from '../audit.ts';
import type { Database, Queryable } from '../db.ts';
import {
  cappedErrors,
  countKind,
  planImport,
  PRODUCT_FIELDS,
  referencedSlugs,
  type CatalogSnapshot,
  type CsvRowError,
  type ExistingProduct,
  type ExportRow,
  type ParsedCsv,
  type PlannedChange,
  type ProductValue,
  type Unit,
} from '../domain/catalogCsv.ts';
import { isoSql } from '../http/serialize.ts';

/** `pg_advisory_xact_lock` key for "the category tree is being re-parented". */
export const CATEGORY_TREE_LOCK = 4_242_001;
const SKU_CONSTRAINT = 'uq_products_sku';
const PRODUCT_SLUG_CONSTRAINT = 'uq_products_slug';
const CATEGORY_SLUG_CONSTRAINT = 'uq_categories_slug';
const CATEGORY_AUDIT_FIELDS = [
  'slug',
  'name_uz',
  'name_ru',
  'parent_id',
  'image_url',
  'sort_order',
  'is_active',
] as const;
const PRODUCT_WRITE_FIELDS = ['sku', ...PRODUCT_FIELDS] as const;

export const PRODUCT_STATUS_FILTERS = ['active', 'inactive', 'archived', 'all'] as const;
export type ProductStatusFilter = (typeof PRODUCT_STATUS_FILTERS)[number];

// --- errors ---------------------------------------------------------------------------------------

export class AdminCatalogError extends Error {}
export class CategoryNotFoundError extends AdminCatalogError {}
/** A `parent_id` / `category_id` in the request body does not exist. */
export class ReferencedCategoryNotFoundError extends AdminCatalogError {
  readonly field: string;
  constructor(field: string) {
    super(field);
    this.field = field;
  }
}
export class CategoryCycleError extends AdminCatalogError {}
export class CategoryNotEmptyError extends AdminCatalogError {}
export class SlugTakenError extends AdminCatalogError {}
export class SkuTakenError extends AdminCatalogError {}
export class ProductNotFoundError extends AdminCatalogError {}
export class ProductArchivedError extends AdminCatalogError {}
/** `old_price_uzs` must be above `price_uzs` (checked on the merged values). */
export class InvalidOldPriceError extends AdminCatalogError {}

// --- records (already in response shape and key order) --------------------------------------------

export interface AdminCategoryRecord {
  id: string;
  parent_id: string | null;
  slug: string;
  name_uz: string;
  name_ru: string;
  image_url: string | null;
  sort_order: number;
  is_active: boolean;
  product_count: number;
  child_count: number;
  created_at: string;
  updated_at: string;
}

export interface AdminProductRecord {
  id: string;
  sku: string;
  slug: string;
  category_id: string;
  name_uz: string;
  name_ru: string;
  description_uz: string | null;
  description_ru: string | null;
  unit: Unit;
  price_uzs: number;
  old_price_uzs: number | null;
  stock_quantity: number | null;
  image_url: string | null;
  sort_order: number;
  is_active: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CsvImportOutcome {
  dry_run: boolean;
  applied: boolean;
  total_rows: number;
  creates: number;
  updates: number;
  unchanged: number;
  errors: CsvRowError[];
  errors_truncated: boolean;
}

// --- helpers --------------------------------------------------------------------------------------

function constraintOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  if (code !== '23505' && code !== '23503') return null;
  return typeof constraint === 'string' ? constraint : null;
}

/** Map a unique / foreign-key violation to the rule it breaks (`null`: rethrow). */
function writeError(error: unknown, referenceField: string): AdminCatalogError | null {
  const name = constraintOf(error) ?? '';
  if (name === SKU_CONSTRAINT) return new SkuTakenError();
  if (name === PRODUCT_SLUG_CONSTRAINT || name === CATEGORY_SLUG_CONSTRAINT)
    return new SlugTakenError();
  if (name.startsWith('fk_')) return new ReferencedCategoryNotFoundError(referenceField);
  return null;
}

async function mapWriteErrors<T>(referenceField: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const mapped = writeError(error, referenceField);
    if (mapped === null) throw error;
    throw mapped;
  }
}

/** `escape_like`: backslash, `%` and `_` match literally under `ESCAPE '\'`. */
export function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

const PRODUCT_COLUMNS = `
  p.id::text AS id, p.sku, p.slug, p.category_id::text AS category_id, p.name_uz, p.name_ru,
  p.description_uz, p.description_ru, p.unit::text AS unit, p.price_uzs, p.old_price_uzs,
  p.stock_quantity, p.image_url, p.sort_order, p.is_active,
  ${isoSql('p.archived_at')} AS archived_at, ${isoSql('p.created_at')} AS created_at,
  ${isoSql('p.updated_at')} AS updated_at`;

const CATEGORY_SELECT = `
  SELECT c.id::text AS id, c.parent_id::text AS parent_id, c.slug, c.name_uz, c.name_ru,
         c.image_url, c.sort_order, c.is_active,
         COALESCE(pc.n, 0) AS product_count, COALESCE(cc.n, 0) AS child_count,
         ${isoSql('c.created_at')} AS created_at, ${isoSql('c.updated_at')} AS updated_at
  FROM categories c
  LEFT JOIN (SELECT category_id, count(*) AS n FROM products GROUP BY category_id) pc
    ON pc.category_id = c.id
  LEFT JOIN (SELECT parent_id, count(*) AS n FROM categories child
             WHERE parent_id IS NOT NULL GROUP BY parent_id) cc
    ON cc.parent_id = c.id`;

function statusCondition(status: ProductStatusFilter | null): string | null {
  if (status === null) return 'p.archived_at IS NULL';
  switch (status) {
    case 'active':
      return 'p.is_active IS true';
    case 'inactive':
      return 'p.is_active IS false AND p.archived_at IS NULL';
    case 'archived':
      return 'p.archived_at IS NOT NULL';
    case 'all':
      return null;
  }
}

function pick(record: object, fields: readonly string[]): Record<string, AuditValue> {
  const source = record as Record<string, AuditValue>;
  const out: Record<string, AuditValue> = {};
  for (const field of fields) out[field] = source[field] ?? null;
  return out;
}

const createdChanges = (values: Record<string, AuditValue>): FieldChanges => {
  const changes: FieldChanges = {};
  for (const [field, value] of Object.entries(values)) changes[field] = [null, value];
  return changes;
};

/** `UPDATE <table> SET a = $2, b = $3, updated_at = now() WHERE id = $1` for whitelisted fields. */
async function updateFields(
  client: Queryable,
  table: 'categories' | 'products',
  id: string,
  changes: FieldChanges,
  allowed: readonly string[],
): Promise<void> {
  const fields = Object.keys(changes).filter((field) => allowed.includes(field));
  if (fields.length === 0) return;
  const sets = fields.map((field, index) => `${field} = $${index + 2}`);
  await client.query(`UPDATE ${table} SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, [
    id,
    ...fields.map((field) => changes[field]?.[1] ?? null),
  ]);
}

// --- repository -----------------------------------------------------------------------------------

export class AdminCatalogRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  // --- categories -------------------------------------------------------------------------------

  async listCategories(): Promise<AdminCategoryRecord[]> {
    const { rows } = await this.db.query<AdminCategoryRecord>(
      `${CATEGORY_SELECT} ORDER BY c.sort_order, c.name_uz, c.id`,
    );
    return rows;
  }

  private async loadCategory(client: Queryable, id: string): Promise<AdminCategoryRecord> {
    const { rows } = await client.query<AdminCategoryRecord>(`${CATEGORY_SELECT} WHERE c.id = $1`, [
      id,
    ]);
    const row = rows[0];
    if (!row) throw new Error('category vanished inside its transaction');
    return row;
  }

  private async categoryExists(client: Queryable, id: string): Promise<boolean> {
    const { rows } = await client.query('SELECT 1 FROM categories WHERE id = $1', [id]);
    return rows.length > 0;
  }

  async createCategory(
    values: Record<string, unknown>,
    actor: AuditActor,
  ): Promise<AdminCategoryRecord> {
    return mapWriteErrors('parent_id', () =>
      this.db.tx(async (client) => {
        const parentId = (values['parent_id'] as string | null) ?? null;
        if (parentId !== null && !(await this.categoryExists(client, parentId))) {
          throw new ReferencedCategoryNotFoundError('parent_id');
        }
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO categories (id, parent_id, slug, name_uz, name_ru, image_url, sort_order, is_active)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7) RETURNING id::text AS id`,
          [
            parentId,
            values['slug'],
            values['name_uz'],
            values['name_ru'],
            values['image_url'] ?? null,
            values['sort_order'],
            values['is_active'],
          ],
        );
        const id = rows[0]?.id as string;
        await recordAudit(client, actor, {
          action: 'category.create',
          entityType: AuditEntity.CATEGORY,
          entityId: id,
          changes: createdChanges(pick({ ...values, parent_id: parentId }, CATEGORY_AUDIT_FIELDS)),
        });
        return this.loadCategory(client, id);
      }),
    );
  }

  /** Whether `categoryId` is `of` or one of its ancestors. */
  private async isAncestorOrSelf(
    client: Queryable,
    categoryId: string,
    of: string,
  ): Promise<boolean> {
    const { rows } = await client.query(
      `WITH RECURSIVE ancestors(id, parent_id) AS (
         SELECT id, parent_id FROM categories WHERE id = $2
         UNION
         SELECT c.id, c.parent_id FROM categories c JOIN ancestors a ON c.id = a.parent_id
       )
       SELECT 1 FROM ancestors WHERE id = $1 LIMIT 1`,
      [categoryId, of],
    );
    return rows.length > 0;
  }

  async updateCategory(
    categoryId: string,
    values: Record<string, unknown>,
    actor: AuditActor,
  ): Promise<AdminCategoryRecord> {
    return mapWriteErrors('parent_id', () =>
      this.db.tx(async (client) => {
        if ('parent_id' in values) {
          await client.query('SELECT pg_advisory_xact_lock($1)', [CATEGORY_TREE_LOCK]);
        }
        const { rows } = await client.query<Record<string, AuditValue>>(
          `SELECT slug, name_uz, name_ru, parent_id::text AS parent_id, image_url, sort_order, is_active
           FROM categories WHERE id = $1 FOR UPDATE`,
          [categoryId],
        );
        const current = rows[0];
        if (!current) throw new CategoryNotFoundError();
        const parentId = (values['parent_id'] as string | null | undefined) ?? null;
        if (parentId !== null && parentId !== current['parent_id']) {
          if (!(await this.categoryExists(client, parentId))) {
            throw new ReferencedCategoryNotFoundError('parent_id');
          }
          if (await this.isAncestorOrSelf(client, categoryId, parentId))
            throw new CategoryCycleError();
        }
        const before = pick(current, CATEGORY_AUDIT_FIELDS);
        const after = { ...before };
        for (const [name, value] of Object.entries(values)) after[name] = value as AuditValue;
        const changes = diffFields(before, pick(after, CATEGORY_AUDIT_FIELDS));
        if (Object.keys(changes).length > 0) {
          await updateFields(client, 'categories', categoryId, changes, CATEGORY_AUDIT_FIELDS);
          await recordAudit(client, actor, {
            action: 'category.update',
            entityType: AuditEntity.CATEGORY,
            entityId: categoryId,
            changes,
          });
        }
        return this.loadCategory(client, categoryId);
      }),
    );
  }

  async deleteCategory(categoryId: string, actor: AuditActor): Promise<void> {
    try {
      await this.db.tx(async (client) => {
        const { rows } = await client.query<{ slug: string }>(
          'SELECT slug FROM categories WHERE id = $1 FOR UPDATE',
          [categoryId],
        );
        const category = rows[0];
        if (!category) throw new CategoryNotFoundError();
        const inUse = await client.query<{ in_use: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM categories WHERE parent_id = $1)
               OR EXISTS (SELECT 1 FROM products WHERE category_id = $1) AS in_use`,
          [categoryId],
        );
        if (inUse.rows[0]?.in_use) throw new CategoryNotEmptyError();
        await client.query('DELETE FROM categories WHERE id = $1', [categoryId]);
        await recordAudit(client, actor, {
          action: 'category.delete',
          entityType: AuditEntity.CATEGORY,
          entityId: categoryId,
          extra: { slug: category.slug },
        });
      });
    } catch (error) {
      // A child or product was added concurrently (the foreign keys are RESTRICT).
      if ((constraintOf(error) ?? '').startsWith('fk_')) throw new CategoryNotEmptyError();
      throw error;
    }
  }

  // --- products ---------------------------------------------------------------------------------

  async listProducts(options: {
    query: string | null;
    categoryId: string | null;
    status: ProductStatusFilter | null;
    page: number;
    pageSize: number;
  }): Promise<{ items: AdminProductRecord[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const status = statusCondition(options.status);
    if (status !== null) conditions.push(status);
    if (options.categoryId !== null) {
      params.push(options.categoryId);
      conditions.push(`p.category_id = $${params.length}`);
    }
    if (options.query) {
      params.push(`%${escapeLike(options.query)}%`);
      const n = params.length;
      conditions.push(
        `(p.name_uz ILIKE $${n} ESCAPE '\\' OR p.name_ru ILIKE $${n} ESCAPE '\\' ` +
          `OR p.sku ILIKE $${n} ESCAPE '\\' OR p.slug ILIKE $${n} ESCAPE '\\')`,
      );
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const count = await this.db.query<{ total: number }>(
      `SELECT count(*) AS total FROM products p ${where}`,
      params,
    );
    const total = count.rows[0]?.total ?? 0;
    const offset = (options.page - 1) * options.pageSize;
    if (offset >= total) return { items: [], total };
    const { rows } = await this.db.query<AdminProductRecord>(
      `SELECT ${PRODUCT_COLUMNS} FROM products p ${where}
       ORDER BY p.sort_order, p.name_uz, p.id
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, options.pageSize, offset],
    );
    return { items: rows, total };
  }

  private async loadProduct(client: Queryable, id: string): Promise<AdminProductRecord> {
    const { rows } = await client.query<AdminProductRecord>(
      `SELECT ${PRODUCT_COLUMNS} FROM products p WHERE p.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new Error('product vanished inside its transaction');
    return row;
  }

  async getProduct(productId: string): Promise<AdminProductRecord | null> {
    const { rows } = await this.db.query<AdminProductRecord>(
      `SELECT ${PRODUCT_COLUMNS} FROM products p WHERE p.id = $1`,
      [productId],
    );
    return rows[0] ?? null;
  }

  private async lockProduct(client: Queryable, id: string): Promise<AdminProductRecord> {
    const { rows } = await client.query<AdminProductRecord>(
      `SELECT ${PRODUCT_COLUMNS} FROM products p WHERE p.id = $1 FOR UPDATE`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new ProductNotFoundError();
    return row;
  }

  private async insertProduct(client: Queryable, values: Record<string, unknown>): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO products (id, sku, slug, category_id, name_uz, name_ru, description_uz,
                             description_ru, unit, price_uzs, old_price_uzs, stock_quantity,
                             is_active, sort_order, image_url)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id::text AS id`,
      [
        values['sku'],
        values['slug'],
        values['category_id'],
        values['name_uz'],
        values['name_ru'],
        values['description_uz'] ?? null,
        values['description_ru'] ?? null,
        values['unit'],
        values['price_uzs'],
        values['old_price_uzs'] ?? null,
        values['stock_quantity'] ?? null,
        values['is_active'],
        values['sort_order'],
        values['image_url'] ?? null,
      ],
    );
    return rows[0]?.id as string;
  }

  async createProduct(
    values: Record<string, unknown>,
    actor: AuditActor,
  ): Promise<AdminProductRecord> {
    return mapWriteErrors('category_id', () =>
      this.db.tx(async (client) => {
        if (!(await this.categoryExists(client, values['category_id'] as string))) {
          throw new ReferencedCategoryNotFoundError('category_id');
        }
        const id = await this.insertProduct(client, values);
        await recordAudit(client, actor, {
          action: 'product.create',
          entityType: AuditEntity.PRODUCT,
          entityId: id,
          changes: createdChanges(pick(values, PRODUCT_WRITE_FIELDS)),
        });
        return this.loadProduct(client, id);
      }),
    );
  }

  async updateProduct(
    productId: string,
    values: Record<string, unknown>,
    actor: AuditActor,
  ): Promise<AdminProductRecord> {
    return mapWriteErrors('category_id', () =>
      this.db.tx(async (client) => {
        const product = await this.lockProduct(client, productId);
        if (product.archived_at !== null) throw new ProductArchivedError();
        const price = ('price_uzs' in values ? values['price_uzs'] : product.price_uzs) as number;
        const oldPrice = (
          'old_price_uzs' in values ? values['old_price_uzs'] : product.old_price_uzs
        ) as number | null;
        if (oldPrice !== null && oldPrice <= price) throw new InvalidOldPriceError();
        const newCategory = (values['category_id'] as string | null | undefined) ?? null;
        if (
          newCategory !== null &&
          newCategory !== product.category_id &&
          !(await this.categoryExists(client, newCategory))
        ) {
          throw new ReferencedCategoryNotFoundError('category_id');
        }
        const before = pick(product, PRODUCT_WRITE_FIELDS);
        const after = { ...before };
        for (const [name, value] of Object.entries(values)) after[name] = value as AuditValue;
        const changes = diffFields(before, pick(after, PRODUCT_WRITE_FIELDS));
        if (Object.keys(changes).length > 0) {
          await updateFields(client, 'products', productId, changes, PRODUCT_WRITE_FIELDS);
          await recordAudit(client, actor, {
            action: 'product.update',
            entityType: AuditEntity.PRODUCT,
            entityId: productId,
            changes,
          });
        }
        return this.loadProduct(client, productId);
      }),
    );
  }

  async archiveProduct(productId: string, actor: AuditActor): Promise<AdminProductRecord> {
    return this.db.tx(async (client) => {
      const product = await this.lockProduct(client, productId);
      if (product.archived_at === null) {
        await client.query(
          'UPDATE products SET archived_at = now(), is_active = false, updated_at = now() WHERE id = $1',
          [productId],
        );
        await recordAudit(client, actor, {
          action: 'product.archive',
          entityType: AuditEntity.PRODUCT,
          entityId: productId,
          changes: { archived: [false, true], is_active: [product.is_active, false] },
          extra: { sku: product.sku },
        });
      }
      return this.loadProduct(client, productId);
    });
  }

  async restoreProduct(productId: string, actor: AuditActor): Promise<AdminProductRecord> {
    return this.db.tx(async (client) => {
      const product = await this.lockProduct(client, productId);
      if (product.archived_at !== null) {
        // Stays inactive: an admin re-activates it deliberately after checking it.
        await client.query(
          'UPDATE products SET archived_at = NULL, updated_at = now() WHERE id = $1',
          [productId],
        );
        await recordAudit(client, actor, {
          action: 'product.restore',
          entityType: AuditEntity.PRODUCT,
          entityId: productId,
          changes: { archived: [true, false] },
          extra: { sku: product.sku },
        });
      }
      return this.loadProduct(client, productId);
    });
  }

  // --- CSV --------------------------------------------------------------------------------------

  async exportRows(): Promise<ExportRow[]> {
    const { rows } = await this.db.query<ExportRow>(
      `SELECT p.sku, p.slug, c.slug AS category_slug, p.name_uz, p.name_ru, p.description_uz,
              p.description_ru, p.unit::text AS unit, p.price_uzs, p.old_price_uzs,
              p.stock_quantity, p.is_active, p.sort_order, p.image_url,
              to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00'
                AS updated_at
       FROM products p JOIN categories c ON c.id = p.category_id
       WHERE p.archived_at IS NULL
       ORDER BY p.sku`,
    );
    return rows;
  }

  private async catalogSnapshot(client: Queryable, parsed: ParsedCsv): Promise<CatalogSnapshot> {
    const skus = parsed.rows.map((row) => row.sku);
    const productsBySku = new Map<string, ExistingProduct>();
    if (skus.length > 0) {
      const { rows } = await client.query<
        Record<string, ProductValue> & {
          id: string;
          sku: string;
          archived: boolean;
          updated_micros: string;
        }
      >(
        `SELECT p.id::text AS id, p.sku, p.archived_at IS NOT NULL AS archived,
                p.slug, p.category_id::text AS category_id, p.name_uz, p.name_ru, p.description_uz,
                p.description_ru, p.unit::text AS unit, p.price_uzs, p.old_price_uzs,
                p.stock_quantity, p.is_active, p.sort_order, p.image_url,
                (extract(epoch FROM date_trunc('second', p.updated_at))::bigint * 1000000
                  + extract(microseconds FROM p.updated_at)::bigint % 1000000)::text AS updated_micros
         FROM products p WHERE p.sku = ANY($1::text[])`,
        [skus],
      );
      for (const row of rows) {
        const values: Record<string, ProductValue> = {};
        for (const field of PRODUCT_FIELDS) values[field] = row[field] ?? null;
        productsBySku.set(row.sku, {
          id: row.id,
          sku: row.sku,
          archived: row.archived,
          values,
          updated_at: BigInt(row.updated_micros),
        });
      }
    }
    const slugs = [...referencedSlugs(parsed.rows)];
    const slugOwners = new Map<string, string>();
    if (slugs.length > 0) {
      const { rows } = await client.query<{ slug: string; sku: string }>(
        'SELECT slug, sku FROM products WHERE slug = ANY($1::text[])',
        [slugs],
      );
      for (const row of rows) slugOwners.set(row.slug, row.sku);
    }
    const categorySlugs = [...new Set(parsed.rows.map((row) => row.category_slug))];
    const categoryIds = new Map<string, string>();
    if (categorySlugs.length > 0) {
      const { rows } = await client.query<{ slug: string; id: string }>(
        'SELECT slug, id::text AS id FROM categories WHERE slug = ANY($1::text[])',
        [categorySlugs],
      );
      for (const row of rows) categoryIds.set(row.slug, row.id);
    }
    return { products_by_sku: productsBySku, slug_owners: slugOwners, category_ids: categoryIds };
  }

  /** Validate everything; write all of it in this one transaction, or nothing. */
  async importCsv(
    parsed: ParsedCsv,
    dryRun: boolean,
    actor: AuditActor,
  ): Promise<CsvImportOutcome> {
    const willWrite = !dryRun && parsed.errors.length === 0;
    return mapWriteErrors('category_id', () =>
      this.db.tx(async (client) => {
        if (willWrite && parsed.rows.length > 0) {
          await client.query(
            'SELECT id FROM products WHERE sku = ANY($1::text[]) ORDER BY id FOR UPDATE',
            [parsed.rows.map((row) => row.sku)],
          );
        }
        const plan = planImport(parsed.rows, await this.catalogSnapshot(client, parsed));
        const [errors, truncated] = cappedErrors([...parsed.errors, ...plan.errors]);
        const applied = willWrite && errors.length === 0;
        if (applied) {
          await this.apply(client, plan.changes, actor);
          await recordAudit(client, actor, {
            action: 'catalog.import',
            entityType: AuditEntity.CATALOG,
            entityId: 'csv',
            extra: {
              source: 'csv',
              rows: parsed.total_rows,
              creates: countKind(plan, 'create'),
              updates: countKind(plan, 'update'),
              unchanged: countKind(plan, 'unchanged'),
            },
          });
        }
        return {
          dry_run: dryRun,
          applied,
          total_rows: parsed.total_rows,
          creates: countKind(plan, 'create'),
          updates: countKind(plan, 'update'),
          unchanged: countKind(plan, 'unchanged'),
          errors,
          errors_truncated: truncated,
        };
      }),
    );
  }

  private async apply(client: pg.PoolClient, changes: readonly PlannedChange[], actor: AuditActor) {
    for (const change of changes) {
      if (change.kind === 'create') {
        const id = await this.insertProduct(client, { sku: change.sku, ...change.values });
        await recordAudit(client, actor, {
          action: 'product.create',
          entityType: AuditEntity.PRODUCT,
          entityId: id,
          changes: { sku: [null, change.sku], ...change.changes },
          extra: { source: 'csv' },
        });
      } else if (change.kind === 'update') {
        const id = change.product_id as string;
        await updateFields(client, 'products', id, change.changes, PRODUCT_WRITE_FIELDS);
        await recordAudit(client, actor, {
          action: 'product.update',
          entityType: AuditEntity.PRODUCT,
          entityId: id,
          changes: change.changes,
          extra: { source: 'csv', sku: change.sku },
        });
      }
    }
  }
}
