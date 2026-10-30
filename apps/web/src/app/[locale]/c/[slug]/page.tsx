import { isLocale } from '@muniramarket/contracts';
import { EmptyState } from '@muniramarket/ui';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CategoryChips } from '@/components/category-chips';
import { PageContainer } from '@/components/page-container';
import { Pagination } from '@/components/pagination';
import { ProductGrid } from '@/components/product-grid';
import { SortSelect } from '@/components/sort-select';
import { getDictionary } from '@/i18n';
import { formatMessage } from '@/i18n/format';
import { ApiRequestError } from '@/lib/api/errors';
import { fetchCategories, fetchProducts } from '@/lib/api/server';
import { findCategoryPath, localizedName, parsePage, parseSort } from '@/lib/catalog';

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

  const tree = await fetchCategories();
  const path = findCategoryPath(tree, slug);
  const category = path?.at(-1);
  if (path === null || category === undefined) notFound();

  let products;
  try {
    products = await fetchProducts({ category: slug, sort, page });
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === 'category_not_found') notFound();
    throw error;
  }

  const base = `/${locale}/c/${encodeURIComponent(slug)}`;
  const hrefFor = (nextPage: number) => {
    const search = new URLSearchParams();
    if (sort !== 'newest') search.set('sort', sort);
    if (nextPage > 1) search.set('page', String(nextPage));
    const text = search.toString();
    return text === '' ? base : `${base}?${text}`;
  };

  return (
    <main className="flex-1">
      <PageContainer className="flex flex-col gap-5 py-6">
        <nav aria-label={dict.catalog.categoryLabel}>
          <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
            {path.slice(0, -1).map((ancestor) => (
              <li key={ancestor.id}>
                <Link
                  href={`/${locale}/c/${encodeURIComponent(ancestor.slug)}`}
                  className="hover:underline"
                >
                  {localizedName(ancestor, locale)}
                </Link>
                <span aria-hidden="true"> / </span>
              </li>
            ))}
          </ol>
        </nav>
        <h1 className="text-2xl font-bold tracking-tight">{localizedName(category, locale)}</h1>

        <CategoryChips
          categories={category.children}
          locale={locale}
          label={dict.catalog.subcategories}
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {formatMessage(dict.catalog.productsCount, { count: products.total })}
          </p>
          <SortSelect value={sort} basePath={base} />
        </div>

        {products.items.length === 0 ? (
          <EmptyState title={dict.catalog.emptyCategory} />
        ) : (
          <ProductGrid
            products={products.items}
            locale={locale}
            dict={dict}
            label={localizedName(category, locale)}
          />
        )}

        <Pagination
          page={products.page}
          totalPages={products.total_pages}
          hrefFor={(nextPage) => hrefFor(nextPage)}
          dict={dict}
        />
      </PageContainer>
    </main>
  );
}
