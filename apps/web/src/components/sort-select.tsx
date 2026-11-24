'use client';

import { PRODUCT_SORTS, type ProductSort } from '@muniramarket/contracts';
import { useRouter } from 'next/navigation';
import { useId } from 'react';
import { useI18n } from '@/i18n/context';
import { ListboxSelect } from './ui/listbox-select';

export interface SortSelectProps {
  value: ProductSort;
  /** Listing path, e.g. `/uz/c/demo-fruit`. */
  basePath: string;
  /** Other query parameters to keep (for example `q` on the search page). Pagination resets. */
  params?: Readonly<Record<string, string>>;
}

/** URL of the listing sorted by `sort`; the default sort is left out of the query. */
export function sortHref(
  basePath: string,
  sort: ProductSort,
  params: Readonly<Record<string, string>> = {},
) {
  const search = new URLSearchParams(params);
  if (sort !== 'newest') search.set('sort', sort);
  const text = search.toString();
  return text === '' ? basePath : `${basePath}?${text}`;
}

/** Sort pill (custom listbox); changing it navigates to the sorted listing. */
export function SortSelect({ value, basePath, params }: SortSelectProps) {
  const { dict } = useI18n();
  const router = useRouter();
  const labelId = useId();

  return (
    <div className="flex min-w-0 items-center text-sm">
      {/* The pill shows the chosen order; its name stays available to screen readers. */}
      <span id={labelId} className="sr-only">
        {dict.catalog.sortLabel}
      </span>
      <ListboxSelect
        aria-labelledby={labelId}
        variant="chip"
        className="min-w-0"
        value={value}
        options={PRODUCT_SORTS.map((sort) => ({ value: sort, label: dict.catalog.sort[sort] }))}
        onChange={(next) => router.push(sortHref(basePath, next as ProductSort, params))}
      />
    </div>
  );
}
