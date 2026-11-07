/**
 * Admin catalog management: categories and products (`admin` role only); port of
 * services/api/app/api/routes/admin_catalog.py and app/schemas/admin_catalog.py.
 *
 * Every route needs an admin-origin back-office session of a user whose role (re-read on every
 * request) is `admin`; anyone else gets `403 forbidden` before anything is read, for existing and
 * unknown ids alike. Writes also need the CSRF token. Each change and its `audit_log` row commit
 * together. Products are never deleted: `DELETE` archives and `POST .../restore` undoes it.
 */

import { ApiError } from '../errors.ts';
import {
  auditActorOf,
  backOfficeRouterDeps,
  rateLimit,
  requireAdmin,
  requireAdminWriter,
  RULES,
} from '../http/auth.ts';
import { deps, type Ctx } from '../http/context.ts';
import {
  MAX_IMAGE_URL_LENGTH,
  validateImageUrl,
  InvalidImageUrlError,
} from '../domain/imageUrl.ts';
import { hasInvisibleCharacters, INVISIBLE_TEXT_MESSAGE } from '../domain/text.ts';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PRICE_UZS,
  MAX_SLUG_LENGTH,
  MAX_SORT_ORDER,
  MAX_STOCK,
  MIN_SORT_ORDER,
  UNITS,
} from '../domain/catalogCsv.ts';
import {
  AdminCatalogError,
  AdminCatalogRepository,
  CategoryCycleError,
  CategoryNotEmptyError,
  CategoryNotFoundError,
  InvalidOldPriceError,
  PRODUCT_STATUS_FILTERS,
  ProductArchivedError,
  ProductNotFoundError,
  ReferencedCategoryNotFoundError,
  SkuTakenError,
  SlugTakenError,
  type ProductStatusFilter,
} from '../repositories/adminCatalog.ts';
import {
  after,
  bool,
  int,
  internalError,
  json,
  model,
  noContent,
  nullable,
  ok,
  oneOf,
  optional,
  pageOf,
  pathUuid,
  queryParam,
  queryValues,
  readJsonBody,
  required,
  str,
  throwIfInvalid,
  uuid,
  validateBody,
  ValueErr,
  type Issues,
  type ModelResult,
  type V,
} from './adminCommon.ts';
import type { Router } from './index.ts';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE = 100_000;

/** Map an admin catalog rule violation to its public error. */
export function toApiError(error: unknown): unknown {
  if (!(error instanceof AdminCatalogError)) return error;
  if (error instanceof ReferencedCategoryNotFoundError) {
    return new ApiError(422, 'category_not_found', 'Category not found', {
      extra: { details: [{ loc: ['body', error.field], msg: 'Category not found' }] },
    });
  }
  if (error instanceof InvalidOldPriceError) {
    return new ApiError(422, 'validation_error', 'Request validation failed', {
      extra: {
        details: [{ loc: ['body', 'old_price_uzs'], msg: 'old_price_uzs must be above price_uzs' }],
      },
    });
  }
  if (error instanceof CategoryNotFoundError)
    return new ApiError(404, 'category_not_found', 'Category not found');
  if (error instanceof ProductNotFoundError)
    return new ApiError(404, 'product_not_found', 'Product not found');
  if (error instanceof CategoryCycleError) {
    return new ApiError(
      409,
      'category_cycle',
      'A category cannot be moved under itself or its descendants',
    );
  }
  if (error instanceof CategoryNotEmptyError) {
    return new ApiError(
      409,
      'category_not_empty',
      'The category still has subcategories or products',
    );
  }
  if (error instanceof SlugTakenError)
    return new ApiError(409, 'slug_taken', 'Slug is already used');
  if (error instanceof SkuTakenError) return new ApiError(409, 'sku_taken', 'SKU is already used');
  if (error instanceof ProductArchivedError) {
    return new ApiError(409, 'product_archived', 'The product is archived; restore it first');
  }
  return internalError();
}

/** Run a repository call, mapping its rule violations to API errors. */
export async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toApiError(error);
  }
}

// --- request schemas (Pydantic semantics) ----------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_MULTILINE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function singleLine(value: string): string {
  if (CONTROL.test(value)) throw new ValueErr('must be a single line of text');
  if (hasInvisibleCharacters(value)) throw new ValueErr(INVISIBLE_TEXT_MESSAGE);
  return value;
}

function multiLine(raw: string): string {
  const value = raw.replaceAll('\r\n', '\n');
  if (CONTROL_MULTILINE.test(value)) throw new ValueErr('contains control characters');
  if (hasInvisibleCharacters(value, { multiline: true }))
    throw new ValueErr(INVISIBLE_TEXT_MESSAGE);
  return value;
}

function imageUrlCheck(value: string | null): string | null {
  const blankToNone = value || null;
  if (blankToNone === null) return null;
  try {
    return validateImageUrl(blankToNone);
  } catch (error) {
    if (error instanceof InvalidImageUrlError) throw new ValueErr(error.message);
    throw error;
  }
}

const Slug = str({
  strip: true,
  minLength: 1,
  maxLength: MAX_SLUG_LENGTH,
  pattern: [SLUG_RE, '^[a-z0-9]+(?:-[a-z0-9]+)*$'],
});
const Sku = str({ strip: true, pattern: [SKU_RE, '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'] });
const Name = after(str({ strip: true, minLength: 1, maxLength: MAX_NAME_LENGTH }), singleLine);
const Description: V<string | null> = after(
  nullable(after(str({ strip: true, maxLength: MAX_DESCRIPTION_LENGTH }), multiLine)),
  (value) => value || null,
);
const ImageUrl: V<string | null> = after(
  nullable(str({ strip: true, maxLength: MAX_IMAGE_URL_LENGTH })),
  imageUrlCheck,
);
const Price = int({ ge: 0, le: MAX_PRICE_UZS });
const Stock = int({ ge: 0, le: MAX_STOCK });
const SortOrder = int({ ge: MIN_SORT_ORDER, le: MAX_SORT_ORDER });
const Unit = oneOf(UNITS);

/** PATCH body: refuses `null` for non-nullable fields and an empty body. */
function patchCheck(nullableFields: ReadonlySet<string>) {
  return ({ values, fieldsSet }: ModelResult): void => {
    if (fieldsSet.size === 0) throw new ValueErr('send at least one field');
    for (const name of fieldsSet) {
      if (values[name] === null && !nullableFields.has(name))
        throw new ValueErr(`${name} cannot be null`);
    }
  };
}

/** Only the fields that were sent. */
export function sentChanges({ values, fieldsSet }: ModelResult): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const name of fieldsSet) changes[name] = values[name];
  return changes;
}

const CategoryCreate = model({
  slug: required(Slug),
  name_uz: required(Name),
  name_ru: required(Name),
  parent_id: optional(nullable(uuid)),
  image_url: optional(ImageUrl),
  sort_order: optional(SortOrder, 0),
  is_active: optional(bool, true),
});

const CategoryUpdate = model(
  {
    slug: optional(nullable(Slug)),
    name_uz: optional(nullable(Name)),
    name_ru: optional(nullable(Name)),
    parent_id: optional(nullable(uuid)),
    image_url: optional(ImageUrl),
    sort_order: optional(nullable(SortOrder)),
    is_active: optional(nullable(bool)),
  },
  patchCheck(new Set(['parent_id', 'image_url'])),
);

const ProductCreate = model(
  {
    sku: required(Sku),
    slug: required(Slug),
    category_id: required(uuid),
    name_uz: required(Name),
    name_ru: required(Name),
    description_uz: optional(Description),
    description_ru: optional(Description),
    unit: required(Unit),
    price_uzs: required(Price),
    old_price_uzs: optional(nullable(Price)),
    stock_quantity: optional(nullable(Stock)),
    image_url: optional(ImageUrl),
    sort_order: optional(SortOrder, 0),
    is_active: optional(bool, true),
  },
  ({ values }) => {
    const oldPrice = values['old_price_uzs'] as number | null;
    if (oldPrice !== null && oldPrice <= (values['price_uzs'] as number)) {
      throw new ValueErr('old_price_uzs must be above price_uzs');
    }
  },
);

const ProductUpdate = model(
  {
    sku: optional(nullable(Sku)),
    slug: optional(nullable(Slug)),
    category_id: optional(nullable(uuid)),
    name_uz: optional(nullable(Name)),
    name_ru: optional(nullable(Name)),
    description_uz: optional(Description),
    description_ru: optional(Description),
    unit: optional(nullable(Unit)),
    price_uzs: optional(nullable(Price)),
    old_price_uzs: optional(nullable(Price)),
    stock_quantity: optional(nullable(Stock)),
    image_url: optional(ImageUrl),
    sort_order: optional(nullable(SortOrder)),
    is_active: optional(nullable(bool)),
  },
  patchCheck(
    new Set(['description_uz', 'description_ru', 'old_price_uzs', 'stock_quantity', 'image_url']),
  ),
);

const repo = (c: Ctx): AdminCatalogRepository => new AdminCatalogRepository(deps(c).db);

// --- handlers -------------------------------------------------------------------------------------

/** Router deps, the route's rate limit, then the admin role (reads). */
export async function adminRead(c: Ctx) {
  await backOfficeRouterDeps(c);
  await rateLimit(c, RULES.ADMIN_READ, 'user');
  return requireAdmin(c);
}

/** Router deps, the route's rate limit, then the CSRF-checked admin role (writes). */
export async function adminWrite(c: Ctx) {
  await backOfficeRouterDeps(c);
  await rateLimit(c, RULES.ADMIN_WRITE, 'user');
  return requireAdminWriter(c);
}

async function listCategories(c: Ctx): Promise<Response> {
  await adminRead(c);
  return json({ items: await repo(c).listCategories() });
}

async function createCategory(c: Ctx): Promise<Response> {
  const body = await readJsonBody(c);
  const admin = await adminWrite(c);
  const issues: Issues = [];
  const payload = validateBody(body, CategoryCreate, issues);
  throwIfInvalid(issues);
  const record = await mapped(() =>
    repo(c).createCategory(ok(payload).values, auditActorOf(admin)),
  );
  return json(record, 201);
}

async function updateCategory(c: Ctx): Promise<Response> {
  const body = await readJsonBody(c);
  const admin = await adminWrite(c);
  const issues: Issues = [];
  const id = pathUuid(c, 'category_id', issues);
  const payload = validateBody(body, CategoryUpdate, issues);
  throwIfInvalid(issues);
  const record = await mapped(() =>
    repo(c).updateCategory(ok(id), sentChanges(ok(payload)), auditActorOf(admin)),
  );
  return json(record);
}

async function deleteCategory(c: Ctx): Promise<Response> {
  const admin = await adminWrite(c);
  const issues: Issues = [];
  const id = pathUuid(c, 'category_id', issues);
  throwIfInvalid(issues);
  await mapped(() => repo(c).deleteCategory(ok(id), auditActorOf(admin)));
  return noContent();
}

async function listProducts(c: Ctx): Promise<Response> {
  await adminRead(c);
  const issues: Issues = [];
  const query = queryValues(c);
  const q = queryParam(query, 'q', str({ maxLength: 100 }), null as string | null, issues);
  const categoryId = queryParam(query, 'category_id', uuid, null as string | null, issues);
  const status = queryParam(
    query,
    'status',
    oneOf(PRODUCT_STATUS_FILTERS),
    null as ProductStatusFilter | null,
    issues,
  );
  const page = queryParam(query, 'page', int({ ge: 1, le: MAX_PAGE }), 1, issues);
  const pageSize = queryParam(
    query,
    'page_size',
    int({ ge: 1, le: MAX_PAGE_SIZE }),
    DEFAULT_PAGE_SIZE,
    issues,
  );
  throwIfInvalid(issues);
  const trimmed = (ok(q) ?? '').trim();
  const record = await repo(c).listProducts({
    query: trimmed || null,
    categoryId: ok(categoryId),
    status: ok(status),
    page: ok(page),
    pageSize: ok(pageSize),
  });
  return json(pageOf(record.items, ok(page), ok(pageSize), record.total));
}

async function getProduct(c: Ctx): Promise<Response> {
  await adminRead(c);
  const issues: Issues = [];
  const id = pathUuid(c, 'product_id', issues);
  throwIfInvalid(issues);
  const record = await repo(c).getProduct(ok(id));
  if (record === null) throw toApiError(new ProductNotFoundError());
  return json(record);
}

async function createProduct(c: Ctx): Promise<Response> {
  const body = await readJsonBody(c);
  const admin = await adminWrite(c);
  const issues: Issues = [];
  const payload = validateBody(body, ProductCreate, issues);
  throwIfInvalid(issues);
  const record = await mapped(() => repo(c).createProduct(ok(payload).values, auditActorOf(admin)));
  return json(record, 201);
}

async function updateProduct(c: Ctx): Promise<Response> {
  const body = await readJsonBody(c);
  const admin = await adminWrite(c);
  const issues: Issues = [];
  const id = pathUuid(c, 'product_id', issues);
  const payload = validateBody(body, ProductUpdate, issues);
  throwIfInvalid(issues);
  const record = await mapped(() =>
    repo(c).updateProduct(ok(id), sentChanges(ok(payload)), auditActorOf(admin)),
  );
  return json(record);
}

async function archiveProduct(c: Ctx): Promise<Response> {
  const admin = await adminWrite(c);
  const issues: Issues = [];
  const id = pathUuid(c, 'product_id', issues);
  throwIfInvalid(issues);
  return json(await mapped(() => repo(c).archiveProduct(ok(id), auditActorOf(admin))));
}

async function restoreProduct(c: Ctx): Promise<Response> {
  const admin = await adminWrite(c);
  const issues: Issues = [];
  const id = pathUuid(c, 'product_id', issues);
  throwIfInvalid(issues);
  return json(await mapped(() => repo(c).restoreProduct(ok(id), auditActorOf(admin))));
}

export function register(router: Router): void {
  router.get('/admin/categories', listCategories);
  router.post('/admin/categories', createCategory);
  router.patch('/admin/categories/{category_id}', updateCategory);
  router.delete('/admin/categories/{category_id}', deleteCategory);
  router.get('/admin/products', listProducts);
  router.get('/admin/products/{product_id}', getProduct);
  router.post('/admin/products', createProduct);
  router.patch('/admin/products/{product_id}', updateProduct);
  router.delete('/admin/products/{product_id}', archiveProduct);
  router.post('/admin/products/{product_id}/restore', restoreProduct);
}
