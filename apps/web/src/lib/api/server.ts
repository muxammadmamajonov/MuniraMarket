import 'server-only';
import type {
  CategoryList,
  CategoryNode,
  ProductDetail,
  ProductPage,
  ProductSort,
} from '@muniramarket/contracts';
import { internalApiUrl } from '@/lib/config';
import { ApiRequestError, readJson } from './errors';

/**
 * Server-side catalog fetchers for Server Components. They call the Core API directly through
 * `API_INTERNAL_URL` (no proxy hop) and only touch public, cookie-less endpoints.
 */

const REQUEST_TIMEOUT_MS = 10_000;

async function getJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(internalApiUrl(path), {
      ...init,
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw ApiRequestError.network(cause);
  }
  if (!response.ok) throw await ApiRequestError.fromResponse(response);
  return readJson<T>(response);
}

/** Active category tree. Cached briefly: it changes rarely and every page needs it. */
export async function fetchCategories(): Promise<CategoryNode[]> {
  const list = await getJson<CategoryList>('/categories', { next: { revalidate: 30 } });
  return list.items;
}

export interface ProductQuery {
  category?: string | undefined;
  q?: string | undefined;
  sort?: ProductSort | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

/** Builds the `/products` query string; omits unset values so API defaults apply. */
export function productQueryString(query: ProductQuery): string {
  const params = new URLSearchParams();
  if (query.category) params.set('category', query.category);
  if (query.q) params.set('q', query.q);
  if (query.sort) params.set('sort', query.sort);
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.pageSize !== undefined) params.set('page_size', String(query.pageSize));
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

export function fetchProducts(query: ProductQuery): Promise<ProductPage> {
  return getJson<ProductPage>(`/products${productQueryString(query)}`, { cache: 'no-store' });
}

/** Product by slug, or `null` when the API answers 404 `product_not_found`. */
export async function fetchProduct(slug: string): Promise<ProductDetail | null> {
  try {
    return await getJson<ProductDetail>(`/products/${encodeURIComponent(slug)}`, {
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === 'product_not_found') return null;
    throw error;
  }
}
