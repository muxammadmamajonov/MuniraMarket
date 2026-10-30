import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from './errors';
import { fetchCategories, fetchProduct, fetchProducts, productQueryString } from './server';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv('API_INTERNAL_URL', 'http://api.test:8000');
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('productQueryString', () => {
  it('omits unset values', () => {
    expect(productQueryString({})).toBe('');
    expect(productQueryString({ category: 'demo', page: 2, sort: 'name', pageSize: 12 })).toBe(
      '?category=demo&sort=name&page=2&page_size=12',
    );
  });

  it('encodes free text', () => {
    expect(productQueryString({ q: 'ol ma&x' })).toBe('?q=ol+ma%26x');
  });
});

describe('server fetchers', () => {
  it('calls the API directly through API_INTERNAL_URL', async () => {
    fetchMock.mockResolvedValue(Response.json({ items: [{ id: '1', children: [] }] }));
    const items = await fetchCategories();
    expect(items).toHaveLength(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://api.test:8000/api/v1/categories');
  });

  it('fetches a product page with the query', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ items: [], page: 1, page_size: 24, total: 0, total_pages: 0 }),
    );
    await fetchProducts({ category: 'demo-fruit', sort: 'price_asc' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://api.test:8000/api/v1/products?category=demo-fruit&sort=price_asc',
    );
  });

  it('returns null for an unknown product', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: { code: 'product_not_found', message: 'x' } }, { status: 404 }),
    );
    expect(await fetchProduct('nope')).toBeNull();
  });

  it('rethrows other API errors', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: { code: 'internal_error', message: 'x' } }, { status: 500 }),
    );
    await expect(fetchProduct('x')).rejects.toMatchObject({ code: 'internal_error', status: 500 });
  });

  it('maps an unreachable API to a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const error = await fetchCategories().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).isNetworkError).toBe(true);
  });
});
