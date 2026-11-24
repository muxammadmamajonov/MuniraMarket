import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { CartBar } from '@/components/cart-bar';
import { CategoryGrid } from '@/components/category-grid';
import { EmptyPanel } from '@/components/empty-panel';
import { BasketIcon } from '@/components/icons';
import { PageContainer } from '@/components/page-container';
import { SearchForm } from '@/components/search-form';
import { SiteHeader } from '@/components/site-header';
import { getDictionary } from '@/i18n';
import { fetchCategories } from '@/lib/api/server';

/** The whole catalog: search and every top-level category. The "Catalog" tab lands here. */
export default async function CatalogPage({ params }: PageProps<'/[locale]/catalog'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const dict = getDictionary(locale);
  const t = dict.catalogPage;
  const categories = await fetchCategories();

  return (
    <>
      <SiteHeader locale={locale} dict={dict} title={dict.pageTitles.catalog} />
      <main className="flex-1">
        <PageContainer className="flex flex-col gap-4 py-4">
          <SearchForm locale={locale} dict={dict} />
          {categories.length === 0 ? (
            <EmptyPanel
              icon={<BasketIcon width={28} height={28} />}
              title={t.emptyTitle}
              description={t.emptyHint}
            />
          ) : (
            <CategoryGrid categories={categories} locale={locale} label={t.title} />
          )}
          <CartBar />
        </PageContainer>
      </main>
    </>
  );
}
