import { isLocale } from '@muniramarket/contracts';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CartBar } from '@/components/cart-bar';
import { CatalogToolbar } from '@/components/catalog-toolbar';
import { CategoryChips } from '@/components/category-chips';
import { CategoryRail } from '@/components/category-rail';
import { EmptyPanel } from '@/components/empty-panel';
import { BasketIcon } from '@/components/icons';
import { PageContainer } from '@/components/page-container';
import { Pagination } from '@/components/pagination';
import { ProductGrid } from '@/components/product-grid';
import { SessionNotice } from '@/components/session-notice';
import { SiteHeader } from '@/components/site-header';
import { LINK_BUTTON_PRIMARY } from '@/components/ui-classes';
import { getDictionary } from '@/i18n';
import { ApiRequestError } from '@/lib/api/errors';
import { fetchCategories, fetchProducts } from '@/lib/api/server';
import {
  findCategoryPath,
  listingHref,
  localizedName,
  parseInStock,
  parsePage,
  parseSort,
} from '@/lib/catalog';

export default async function CategoryPage({
  params,
  searchParams,
}: PageProps<'/[locale]/c/[slug]'>) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  const query = await searchParams;
  const dict = getDictionary(locale);
  const sort = parseSort(query['sort']);
  const page = parsePage(query['page']);
  const inStock = parseInStock(query['stock']);

  const tree = await fetchCategories();
  const path = findCategoryPath(tree, slug);
  const category = path?.at(-1);
  if (path === null || category === undefined) notFound();

  let products;
  try {
    products = await fetchProducts({ category: slug, sort, page, inStock });
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === 'category_not_found') notFound();
    throw error;
  }

  const parent = path.length > 1 ? path.at(-2) : undefined;
  const chips = category.children.length > 0 ? category.children : (parent?.children ?? []);

  const base = `/${locale}/c/${encodeURIComponent(slug)}`;
  const hrefFor = (nextPage: number) => listingHref(base, { sort, inStock, page: nextPage });

  const name = localizedName(category, locale);
  // Telegram's BackButton without history: up one level (sub-category -> category -> catalog).
  const parentHref =
    parent === undefined ? `/${locale}/catalog` : `/${locale}/c/${encodeURIComponent(parent.slug)}`;

  return (
    <>
      <SiteHeader locale={locale} dict={dict} title={name} parentHref={parentHref} />
      <main className="flex-1">
        <PageContainer className="flex flex-col gap-4 py-4">
          {/* Other top-level categories stay one tap away; the current branch is highlighted. */}
          <CategoryRail
            categories={tree}
            locale={locale}
            label={dict.home.categoriesHeading}
            activeSlug={path[0]?.slug}
          />
          {/* Sub-categories; on a leaf category, its siblings with the current one marked, so
            "Fruit" and "Vegetables" stay one tap apart. */}
          <CategoryChips
            categories={chips}
            locale={locale}
            label={`${dict.catalog.subcategories}: ${localizedName(category.children.length > 0 ? category : (parent ?? category), locale)}`}
            activeSlug={slug}
          />

          <CatalogToolbar total={products.total} sort={sort} inStock={inStock} basePath={base} />

          {products.items.length === 0 ? (
            <EmptyPanel
              icon={<BasketIcon width={28} height={28} />}
              title={inStock ? dict.catalog.noneInStock : dict.catalog.emptyCategory}
              action={
                inStock ? (
                  <Link
                    href={listingHref(base, { sort, inStock: false })}
                    className={LINK_BUTTON_PRIMARY}
                  >
                    {dict.catalog.clearFilter}
                  </Link>
                ) : (
                  <Link href={`/${locale}`} className={LINK_BUTTON_PRIMARY}>
                    {dict.errors.backHome}
                  </Link>
                )
              }
            />
          ) : (
            <>
              <SessionNotice />
              <ProductGrid products={products.items} label={name} />
            </>
          )}

          <Pagination
            page={products.page}
            totalPages={products.total_pages}
            hrefFor={(nextPage) => hrefFor(nextPage)}
            dict={dict}
          />
          <CartBar />
        </PageContainer>
      </main>
    </>
  );
}
