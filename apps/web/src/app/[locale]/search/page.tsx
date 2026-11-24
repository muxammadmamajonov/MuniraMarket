import { isLocale } from '@muniramarket/contracts';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CartBar } from '@/components/cart-bar';
import { CatalogToolbar } from '@/components/catalog-toolbar';
import { CategoryRail } from '@/components/category-rail';
import { EmptyPanel } from '@/components/empty-panel';
import { SearchIcon } from '@/components/icons';
import { PageContainer } from '@/components/page-container';
import { Pagination } from '@/components/pagination';
import { ProductGrid } from '@/components/product-grid';
import { SearchForm } from '@/components/search-form';
import { SessionNotice } from '@/components/session-notice';
import { SiteHeader } from '@/components/site-header';
import { LINK_BUTTON_PRIMARY } from '@/components/ui-classes';
import { getDictionary } from '@/i18n';
import { formatMessage } from '@/i18n/format';
import { fetchCategories, fetchProducts } from '@/lib/api/server';
import { firstParam, listingHref, parseInStock, parsePage, parseSort } from '@/lib/catalog';

/** The API accepts 2..100 characters. */
const MIN_QUERY = 2;
const MAX_QUERY = 100;

export default async function SearchPage({ params, searchParams }: PageProps<'/[locale]/search'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const query = await searchParams;
  const dict = getDictionary(locale);

  const q = (firstParam(query['q']) ?? '').trim().slice(0, MAX_QUERY);
  const sort = parseSort(query['sort']);
  const page = parsePage(query['page']);
  const inStock = parseInStock(query['stock']);
  const searched = q.length >= MIN_QUERY;
  const [results, categories] = await Promise.all([
    searched ? fetchProducts({ q, sort, page, inStock }) : null,
    // Categories are a way out of an empty or too-short search; never fatal for the page.
    fetchCategories().catch(() => []),
  ]);

  const base = `/${locale}/search`;
  const hrefFor = (nextPage: number) => listingHref(base, { sort, inStock, page: nextPage }, { q });
  const browse = (
    <CategoryRail categories={categories} locale={locale} label={dict.home.categoriesHeading} />
  );

  return (
    <>
      <SiteHeader locale={locale} dict={dict} title={dict.pageTitles.search} />
      <main className="flex-1">
        <PageContainer className="flex flex-col gap-4 py-4">
          <SearchForm locale={locale} dict={dict} defaultValue={q} />

          {results === null ? (
            <>
              <EmptyPanel
                icon={<SearchIcon width={28} height={28} />}
                title={dict.search.heading}
                description={formatMessage(dict.search.tooShort, { min: MIN_QUERY })}
              />
              {browse}
            </>
          ) : (
            <>
              <CatalogToolbar
                total={results.total}
                sort={sort}
                inStock={inStock}
                basePath={base}
                params={{ q }}
                lead={formatMessage(dict.search.resultsFor, { query: q })}
              />
              {results.items.length === 0 ? (
                <>
                  <EmptyPanel
                    icon={<SearchIcon width={28} height={28} />}
                    title={inStock ? dict.catalog.noneInStock : dict.search.noResults}
                    {...(inStock ? {} : { description: dict.search.noResultsHint })}
                    action={
                      inStock ? (
                        <Link
                          href={listingHref(base, { sort, inStock: false }, { q })}
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
                  {inStock ? null : browse}
                </>
              ) : (
                <>
                  <SessionNotice />
                  <ProductGrid products={results.items} label={dict.search.heading} />
                </>
              )}
              <Pagination
                page={results.page}
                totalPages={results.total_pages}
                hrefFor={hrefFor}
                dict={dict}
              />
            </>
          )}
          <CartBar />
        </PageContainer>
      </main>
    </>
  );
}
