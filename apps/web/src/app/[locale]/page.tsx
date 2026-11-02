import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { CartBar } from '@/components/cart-bar';
import { CategoryRail } from '@/components/category-rail';
import { DeliveryInfo } from '@/components/delivery-info';
import { EmptyPanel } from '@/components/empty-panel';
import { BasketIcon } from '@/components/icons';
import { PageContainer } from '@/components/page-container';
import { ProductGrid } from '@/components/product-grid';
import { SearchForm } from '@/components/search-form';
import { SessionNotice } from '@/components/session-notice';
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
                <h2 id="categories-heading" className="text-lg font-bold">
                  {dict.home.categoriesHeading}
                </h2>
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
                <h2 id="newest-heading" className="text-lg font-bold">
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
