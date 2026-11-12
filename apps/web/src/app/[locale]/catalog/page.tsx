import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { CartBar } from '@/components/cart-bar';
import { CategoryGrid } from '@/components/category-grid';
import { EmptyPanel } from '@/components/empty-panel';
import { BasketIcon } from '@/components/icons';
import { PageContainer } from '@/components/page-container';
import { SearchForm } from '@/components/search-form';
import { PAGE_TITLE } from '@/components/ui-classes';
import { getDictionary } from '@/i18n';
import { formatMessage } from '@/i18n/format';
import { fetchCategories } from '@/lib/api/server';

/** The whole catalog: search and every top-level category. The "Catalog" tab lands here. */
export default async function CatalogPage({ params }: PageProps<'/[locale]/catalog'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const dict = getDictionary(locale);
  const t = dict.catalogPage;
  const categories = await fetchCategories();

  return (
    <main className="flex-1">
      <PageContainer className="flex flex-col gap-4 py-4">
        <div className="flex flex-col gap-0.5">
          <h1 className={PAGE_TITLE}>{t.title}</h1>
          {categories.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              {formatMessage(t.count, { count: categories.length })}
            </p>
          ) : null}
        </div>
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
  );
}
