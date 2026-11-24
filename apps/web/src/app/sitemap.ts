import { SUPPORTED_LOCALES, type CategoryNode } from '@muniramarket/contracts';
import type { MetadataRoute } from 'next';
import { fetchCategories, fetchProducts } from '@/lib/api/server';
import { localePath, siteOrigin } from '@/lib/site';

/** The Core API's largest catalog page (`CATALOG_MAX_PAGE_SIZE`). */
const PAGE_SIZE = 48;
/** A guard against a runaway loop; far above any real catalog (48 × 200 products). */
const MAX_PAGES = 200;

function categorySlugs(nodes: readonly CategoryNode[]): string[] {
  return nodes.flatMap((node) => [node.slug, ...categorySlugs(node.children)]);
}

async function productSlugs(): Promise<string[]> {
  const slugs: string[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await fetchProducts({ page, pageSize: PAGE_SIZE });
    for (const item of result.items) slugs.push(item.slug);
    if (page * PAGE_SIZE >= result.total) break;
  }
  return slugs;
}

/**
 * Every public, indexable page in both languages: home, catalog, help, each category and each
 * product, each listing its `hreflang` alternates. Private pages (cart, orders, profile, search,
 * sign-in) are left out, as in robots.ts. The catalog is read from the Core API per request.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = siteOrigin();
  const [categories, products] = await Promise.all([fetchCategories(), productSlugs()]);

  const entry = (path: string): MetadataRoute.Sitemap =>
    SUPPORTED_LOCALES.map((locale) => ({
      url: `${origin}${localePath(locale, path)}`,
      alternates: {
        languages: Object.fromEntries(
          SUPPORTED_LOCALES.map((l) => [l, `${origin}${localePath(l, path)}`]),
        ),
      },
    }));

  return [
    ...entry('/'),
    ...entry('/catalog'),
    ...entry('/help'),
    ...categorySlugs(categories).flatMap((slug) => entry(`/c/${encodeURIComponent(slug)}`)),
    ...products.flatMap((slug) => entry(`/p/${encodeURIComponent(slug)}`)),
  ];
}
