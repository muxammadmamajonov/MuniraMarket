'use client';

import { PRODUCT_SORTS, type ProductSort } from '@muniramarket/contracts';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/i18n/context';

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

/** Sort dropdown; changing it navigates to the sorted listing. */
export function SortSelect({ value, basePath, params }: SortSelectProps) {
  const { dict } = useI18n();
  const router = useRouter();

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">{dict.catalog.sortLabel}</span>
      <select
        value={value}
        onChange={(event) =>
          router.push(sortHref(basePath, event.target.value as ProductSort, params))
        }
        className="min-h-11 rounded-xl border border-border bg-surface px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {PRODUCT_SORTS.map((sort) => (
          <option key={sort} value={sort}>
            {dict.catalog.sort[sort]}
          </option>
        ))}
      </select>
    </label>
  );
}
