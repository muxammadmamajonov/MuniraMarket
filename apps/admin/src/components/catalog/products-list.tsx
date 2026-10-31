'use client';

import type {
  AdminCategoryList,
  AdminProduct,
  AdminProductPage,
  ProductStatusFilter,
} from '@muniramarket/contracts';
import { EmptyState, formatUZS } from '@muniramarket/ui';
import Link from 'next/link';
import { useMemo } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import type { ProductStatusChoice } from '@/i18n/dictionaries/sections/products';
import { categoryTree, indentedLabel, localName } from '@/lib/catalog';
import { formatCount } from '@/lib/format';
import { LIST_PAGE_SIZE, isUuid, parseChoice, parsePageParam, parseText } from '@/lib/list-params';
import { useApiResource } from '@/lib/use-api-resource';
import { useUrlParams } from '@/lib/use-url-params';
import { CHIP, CHIP_OFF, CHIP_ON, LINK_BUTTON_PRIMARY, INPUT } from '../ui/classes';
import { DataTable, type Column } from '../ui/data-table';
import { PageHeader } from '../ui/page-header';
import { Pagination } from '../ui/pagination';
import { ResourceView } from '../ui/resource-view';
import { SearchBox } from '../ui/search-box';
import { ProductStatusBadge, productState } from './product-status';

const CHOICES: readonly ProductStatusChoice[] = [
  'default',
  'active',
  'inactive',
  'archived',
  'all',
];

export function productHref(locale: string, id: string): string {
  return `/${locale}/catalog/products/${encodeURIComponent(id)}`;
}

/** Searchable, filterable, paginated product table. Everything but the data lives in the URL. */
export function ProductsList() {
  const { dict, locale } = useI18n();
  const copy = dict.products;
  const { params, replace, hrefWith } = useUrlParams();

  const q = parseText(params.get('q'));
  const status = parseChoice(params.get('status'), CHOICES) ?? 'default';
  const categoryParam = params.get('category_id');
  const categoryId = isUuid(categoryParam) ? categoryParam : '';
  const page = parsePageParam(params.get('page'));

  const query = new URLSearchParams({ page: String(page), page_size: String(LIST_PAGE_SIZE) });
  if (q !== '') query.set('q', q);
  if (status !== 'default') query.set('status', status satisfies ProductStatusFilter);
  if (categoryId !== '') query.set('category_id', categoryId);

  const products = useApiResource<AdminProductPage>(`/admin/products?${query.toString()}`);
  const categories = useApiResource<AdminCategoryList>('/admin/categories');

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const category of categories.data?.items ?? [])
      map.set(category.id, localName(category, locale));
    return map;
  }, [categories.data, locale]);

  const options = useMemo(
    () => categoryTree(categories.data?.items ?? [], locale),
    [categories.data, locale],
  );

  const columns: Array<Column<AdminProduct>> = [
    {
      id: 'name',
      header: copy.columns.name,
      primary: true,
      cell: (product) => (
        <>
          <Link
            href={productHref(locale, product.id)}
            data-testid="product-row-link"
            className="font-semibold underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus"
          >
            {localName(product, locale)}
          </Link>
          <span className="block text-sm text-muted-foreground">
            {copy.columns.sku}: <span className="font-mono">{product.sku}</span>
          </span>
        </>
      ),
    },
    {
      id: 'category',
      header: copy.columns.category,
      desktopOnly: true,
      cell: (product) => names.get(product.category_id) ?? dict.common.noValue,
    },
    {
      id: 'price',
      header: copy.columns.price,
      numeric: true,
      nowrap: true,
      cell: (product) => (
        <>
          {formatUZS(product.price_uzs, locale)}
          {product.old_price_uzs === null ? null : (
            <span className="block text-sm text-muted-foreground line-through">
              {formatUZS(product.old_price_uzs, locale)}
            </span>
          )}
        </>
      ),
    },
    {
      id: 'stock',
      header: copy.columns.stock,
      numeric: true,
      nowrap: true,
      cell: (product) =>
        product.stock_quantity === null ? copy.stockUntracked : formatCount(product.stock_quantity),
    },
    {
      id: 'status',
      header: copy.columns.status,
      nowrap: true,
      cell: (product) => <ProductStatusBadge state={productState(product)} />,
    },
  ];

  const filtered = q !== '' || status !== 'default' || categoryId !== '';

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={copy.title}
        actions={
          <Link
            href={`/${locale}/catalog/products/new`}
            data-testid="new-product"
            className={LINK_BUTTON_PRIMARY}
          >
            {copy.newProduct}
          </Link>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <SearchBox
          value={q}
          onSearch={(next) => replace({ q: next })}
          label={copy.searchLabel}
          placeholder={copy.searchPlaceholder}
          testId="product-search"
        />
        <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
          {copy.categoryFilterLabel}
          <select
            value={categoryId}
            onChange={(event) => replace({ category_id: event.target.value })}
            disabled={categories.status !== 'ready'}
            data-testid="product-category-filter"
            className={`${INPUT} sm:w-60`}
          >
            <option value="">{copy.allCategories}</option>
            {options.map(({ category, depth }) => (
              <option key={category.id} value={category.id}>
                {indentedLabel(localName(category, locale), depth)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <nav aria-label={copy.statusFilterLabel}>
        <ul className="flex flex-wrap gap-2">
          {CHOICES.map((choice) => {
            const selected = choice === status;
            return (
              <li key={choice}>
                <Link
                  href={hrefWith({ status: choice === 'default' ? null : choice })}
                  replace
                  aria-current={selected ? 'true' : undefined}
                  className={`${CHIP} ${selected ? CHIP_ON : CHIP_OFF}`}
                >
                  {copy.statusChoices[choice]}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <ResourceView resource={products} loadingLabel={copy.loading}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState
              title={filtered ? copy.emptyFiltered : copy.empty}
              {...(filtered
                ? {
                    action: (
                      <Link
                        href={hrefWith({ q: null, status: null, category_id: null })}
                        className="font-medium underline underline-offset-2"
                      >
                        {dict.common.resetFilters}
                      </Link>
                    ),
                  }
                : {})}
            />
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground tabular">
                {formatMessage(dict.common.total, { count: formatCount(data.total) })}
              </p>
              <DataTable
                caption={copy.table}
                columns={columns}
                rows={data.items}
                rowKey={(product) => product.id}
              />
              <Pagination
                page={page}
                totalPages={data.total_pages}
                hrefFor={(target) => hrefWith({ page: target > 1 ? String(target) : null })}
              />
            </div>
          )
        }
      </ResourceView>
    </div>
  );
}
