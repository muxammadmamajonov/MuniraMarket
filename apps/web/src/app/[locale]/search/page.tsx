import { isLocale } from '@muniramarket/contracts';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CartBar } from '@/components/cart-bar';
import { EmptyPanel } from '@/components/empty-panel';
import { SearchIcon } from '@/components/icons';
import { PageContainer } from '@/components/page-container';
import { Pagination } from '@/components/pagination';
import { ProductGrid } from '@/components/product-grid';
import { SearchForm } from '@/components/search-form';
import { SessionNotice } from '@/components/session-notice';
import { SortSelect } from '@/components/sort-select';
import { LINK_BUTTON_PRIMARY } from '@/components/ui-classes';
import { getDictionary } from '@/i18n';
import { formatMessage } from '@/i18n/format';
import { fetchProducts } from '@/lib/api/server';
import { firstParam, parsePage, parseSort } from '@/lib/catalog';

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
  const searched = q.length >= MIN_QUERY;
  const results = searched ? await fetchProducts({ q, sort, page }) : null;

  const base = `/${locale}/search`;
  const hrefFor = (nextPage: number) => {
    const search = new URLSearchParams({ q });
    if (sort !== 'newest') search.set('sort', sort);
    if (nextPage > 1) search.set('page', String(nextPage));
    return `${base}?${search.toString()}`;
  };

  return (
    <main className="flex-1">
      <PageContainer className="flex flex-col gap-5 py-6">
        <h1 className="text-2xl font-bold tracking-tight">{dict.search.heading}</h1>
        <SearchForm locale={locale} dict={dict} defaultValue={q} />

        {results === null ? (
          <EmptyPanel
            icon={<SearchIcon width={28} height={28} />}
            title={dict.search.heading}
            description={formatMessage(dict.search.tooShort, { min: MIN_QUERY })}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {formatMessage(dict.search.resultsFor, { query: q })}
                {' · '}
                {formatMessage(dict.catalog.productsCount, { count: results.total })}
              </p>
              <SortSelect value={sort} basePath={base} params={{ q }} />
            </div>
            {results.items.length === 0 ? (
              <EmptyPanel
                icon={<SearchIcon width={28} height={28} />}
                title={dict.search.noResults}
                description={dict.search.noResultsHint}
                action={
                  <Link href={`/${locale}`} className={LINK_BUTTON_PRIMARY}>
                    {dict.errors.backHome}
                  </Link>
                }
              />
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
  );
}
