import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchCategories = vi.fn();
const fetchProducts = vi.fn();
vi.mock('@/lib/api/server', () => ({
  fetchCategories: (...a: unknown[]) => fetchCategories(...a),
  fetchProducts: (...a: unknown[]) => fetchProducts(...a),
}));

import sitemap from './sitemap';

const product = (slug: string) => ({ slug });

describe('sitemap', () => {
  beforeEach(() => {
    fetchCategories.mockReset();
    fetchProducts.mockReset();
  });

  it('lists the public pages in both languages with hreflang alternates', async () => {
    fetchCategories.mockResolvedValue([
      { slug: 'dairy', children: [{ slug: 'milk', children: [] }] },
    ]);
    fetchProducts.mockResolvedValue({ items: [product('rice')], total: 1 });

    const urls = (await sitemap()).map((e) => e.url);
    for (const path of ['', '/catalog', '/help', '/c/dairy', '/c/milk', '/p/rice']) {
      expect(urls).toContain(`https://muniramarket.uz/uz${path}`);
      expect(urls).toContain(`https://muniramarket.uz/ru${path}`);
    }
    expect(urls).toHaveLength(12);
    expect(urls.some((u) => /cart|orders|profile|search|auth/.test(u))).toBe(false);

    const rice = (await sitemap()).find((e) => e.url.endsWith('/uz/p/rice'));
    expect(rice?.alternates?.languages).toEqual({
      uz: 'https://muniramarket.uz/uz/p/rice',
      ru: 'https://muniramarket.uz/ru/p/rice',
    });
  });

  it('walks every catalog page', async () => {
    fetchCategories.mockResolvedValue([]);
    fetchProducts
      .mockResolvedValueOnce({ items: [product('a')], total: 49 })
      .mockResolvedValueOnce({ items: [product('b')], total: 49 });

    const urls = (await sitemap()).map((e) => e.url);
    expect(fetchProducts).toHaveBeenCalledTimes(2);
    expect(fetchProducts).toHaveBeenLastCalledWith({ page: 2, pageSize: 48 });
    expect(urls).toContain('https://muniramarket.uz/uz/p/b');
  });

  it('escapes a slug', async () => {
    fetchCategories.mockResolvedValue([]);
    fetchProducts.mockResolvedValue({ items: [product('a b')], total: 1 });
    expect((await sitemap()).map((e) => e.url)).toContain('https://muniramarket.uz/uz/p/a%20b');
  });
});
