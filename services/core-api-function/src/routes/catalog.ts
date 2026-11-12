/**
 * Public catalog (no authentication): categories and products (port of
 * services/api/app/api/routes/catalog.py).
 *
 * Successful responses are `Cache-Control: public, max-age=60`. Every route is rate limited per
 * IP (`catalog_ip`) before any database work; a `429` is `no-store` so no shared cache keeps
 * serving it. Errors carry no public cache header (FastAPI drops the dependency's header too).
 */
import { ApiError } from '../errors.ts';
import { RULES, rateLimit } from '../http/auth.ts';
import { deps, type Ctx } from '../http/context.ts';
import {
  CategoryNotFoundError,
  getProductBySlug,
  listCategoryTree,
  listProducts,
  totalPages,
} from '../repositories/catalog.ts';
import { Validation, str } from '../schemas/storefront/fields.ts';
import { readPath, readQuery } from '../schemas/storefront/http.ts';
import { productQuery } from '../schemas/storefront/requests.ts';
import { categoryNode, productDetail, productPage } from '../schemas/storefront/responses.ts';
import type { Router } from './index.ts';

export const PUBLIC_CACHE = 'public, max-age=60';

/** Router-level dependency: the per-IP limit, before any database work. */
export async function catalogIpLimit(c: Ctx): Promise<void> {
  await rateLimit(c, RULES.CATALOG_IP, 'ip');
}

/** A successful public read, cacheable by shared caches for a minute. */
export function publicJson(c: Ctx, body: unknown): Response {
  return c.json(body, 200, { 'cache-control': PUBLIC_CACHE });
}

const slugParam = str({ min: 1, max: 160 });

/** Active categories as a tree. An inactive category hides its whole subtree. */
async function listCategories(c: Ctx): Promise<Response> {
  await catalogIpLimit(c);
  const records = await listCategoryTree(deps(c).db.pool);
  return publicJson(c, { items: records.map(categoryNode) });
}

/** Active products in active categories, with stable pagination. */
async function listProductsRoute(c: Ctx): Promise<Response> {
  await catalogIpLimit(c);
  const validation = new Validation();
  const query = readQuery(validation, c, productQuery);
  validation.check();
  let result;
  try {
    result = await listProducts(deps(c).db.pool, {
      categorySlug: query.category,
      query: query.q,
      inStockOnly: query.in_stock,
      sort: query.sort,
      page: query.page,
      pageSize: query.page_size,
    });
  } catch (error) {
    if (error instanceof CategoryNotFoundError) {
      throw new ApiError(404, 'category_not_found', 'Category not found');
    }
    throw error;
  }
  return publicJson(
    c,
    productPage(result, query.page, query.page_size, totalPages(result.total, query.page_size)),
  );
}

/** One product. Missing, inactive and products in inactive categories all return 404. */
async function getProduct(c: Ctx): Promise<Response> {
  await catalogIpLimit(c);
  const validation = new Validation();
  const slug = readPath(validation, c, 'slug', slugParam);
  validation.check();
  const record = await getProductBySlug(deps(c).db.pool, slug);
  if (record === null) throw new ApiError(404, 'product_not_found', 'Product not found');
  return publicJson(c, productDetail(record));
}

export function register(router: Router): void {
  router.get('/categories', listCategories);
  router.get('/products', listProductsRoute);
  router.get('/products/{slug}', getProduct);
}
