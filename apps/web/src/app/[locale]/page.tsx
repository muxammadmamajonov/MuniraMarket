import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { CartBar } from '@/components/cart-bar';
import { CategoryRail } from '@/components/category-rail';
import { DeliveryAddressCard } from '@/components/delivery-address-card';
import { DeliveryInfo } from '@/components/delivery-info';
import { EmptyPanel } from '@/components/empty-panel';
import { BasketIcon, ChevronRightIcon } from '@/components/icons';
import { PageContainer } from '@/components/page-container';
import { ProductGrid } from '@/components/product-grid';
import { SearchForm } from '@/components/search-form';
import { SessionNotice } from '@/components/session-notice';
import { FOCUS_RING, PRESS } from '@/components/ui-classes';
import { getDictionary } from '@/i18n';
import { fetchCategories, fetchProducts } from '@/lib/api/server';

const NEWEST_COUNT = 24;

export default async function HomePage({ params }: PageProps<'/[locale]'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const dict = getDictionary(locale);

  const [categories, newest] = await Promise.all([
    fetchCategories(),
    fetchProducts({ sort: 'newest', page: 1, pageSize: NEWEST_COUNT }),
  ]);
  const empty = categories.length === 0 && newest.items.length === 0;

  return (
    <main className="flex-1">
      <PageContainer className="flex flex-col gap-5 py-4">
        {/* The wordmark in the header is the visible name; this keeps one heading per page. */}
        <h1 className="sr-only">{dict.home.title}</h1>

        {/* Delivery first, but never in the way: the catalog below works without an address. */}
        <DeliveryAddressCard />
        <SearchForm locale={locale} dict={dict} />

        {empty ? (
          <EmptyPanel
            icon={<BasketIcon width={28} height={28} />}
            title={dict.home.emptyTitle}
            description={dict.home.emptyHint}
          />
        ) : (
          <>
            {categories.length > 0 ? (
              <section aria-labelledby="categories-heading" className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <h2 id="categories-heading" className="text-xl font-bold tracking-[-0.01em]">
                    {dict.home.categoriesHeading}
                  </h2>
                  <Link
                    href={`/${locale}/catalog`}
                    aria-label={`${dict.home.seeAll}: ${dict.home.categoriesHeading}`}
                    className={`-mr-2 inline-flex min-h-11 items-center gap-0.5 rounded-xl px-2 text-sm font-semibold text-brand-ink ${PRESS} ${FOCUS_RING}`}
                  >
                    {dict.home.seeAll}
                    <ChevronRightIcon aria-hidden="true" width={16} height={16} />
                  </Link>
                </div>
                <CategoryRail
                  categories={categories}
                  locale={locale}
                  label={dict.home.categoriesHeading}
                />
              </section>
            ) : null}

            <DeliveryInfo dict={dict} />
            <SessionNotice />

            {newest.items.length > 0 ? (
              <section aria-labelledby="newest-heading" className="flex flex-col gap-3">
                <h2 id="newest-heading" className="text-xl font-bold tracking-[-0.01em]">
                  {dict.home.newestHeading}
                </h2>
                <ProductGrid products={newest.items} label={dict.home.newestHeading} />
              </section>
            ) : null}
          </>
        )}

        <CartBar />
      </PageContainer>
    </main>
  );
}
