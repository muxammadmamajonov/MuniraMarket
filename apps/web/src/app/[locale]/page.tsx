import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { CategoryChips } from '@/components/category-chips';
import { PageContainer } from '@/components/page-container';
import { ProductGrid } from '@/components/product-grid';
import { SearchForm } from '@/components/search-form';
import { getDictionary } from '@/i18n';
import { fetchCategories, fetchProducts } from '@/lib/api/server';

const NEWEST_COUNT = 12;

export default async function HomePage({ params }: PageProps<'/[locale]'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const dict = getDictionary(locale);

  const [categories, newest] = await Promise.all([
    fetchCategories(),
    fetchProducts({ sort: 'newest', page: 1, pageSize: NEWEST_COUNT }),
  ]);

  return (
    <main className="flex-1">
      <PageContainer className="flex flex-col gap-6 py-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold tracking-tight">{dict.home.title}</h1>
          <p className="text-lg text-muted-foreground">{dict.home.tagline}</p>
        </div>

        <SearchForm locale={locale} dict={dict} />

        <section aria-labelledby="categories-heading" className="flex flex-col gap-3">
          <h2 id="categories-heading" className="text-xl font-semibold">
            {dict.home.categoriesHeading}
          </h2>
          <CategoryChips
            categories={categories}
            locale={locale}
            label={dict.home.categoriesHeading}
          />
        </section>

        <section aria-labelledby="newest-heading" className="flex flex-col gap-3">
          <h2 id="newest-heading" className="text-xl font-semibold">
            {dict.home.newestHeading}
          </h2>
          <ProductGrid
            products={newest.items}
            locale={locale}
            dict={dict}
            label={dict.home.newestHeading}
          />
        </section>
      </PageContainer>
    </main>
  );
}
