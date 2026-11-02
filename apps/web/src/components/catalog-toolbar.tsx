'use client';

import type { ProductSort } from '@muniramarket/contracts';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { listingHref } from '@/lib/catalog';
import { SortSelect } from './sort-select';

export interface CatalogToolbarProps {
  /** Products matching the current filter (the API's `total`). */
  total: number;
  sort: ProductSort;
  inStock: boolean;
  /** Listing path, e.g. `/uz/c/demo-fruit`. */
  basePath: string;
  /** Other query parameters to keep (`q` on the search page). */
  params?: Readonly<Record<string, string>>;
  /** Text before the count, e.g. "Results for …" on the search page. */
  lead?: string;
}

/**
 * Count, the "in stock only" switch and the sort listbox above a product grid. Both controls
 * navigate (the API filters and sorts, so totals and pages stay truthful); the switch flips at once
 * and the grid dims while the new listing loads.
 */
export function CatalogToolbar({
  total,
  sort,
  inStock,
  basePath,
  params = {},
  lead,
}: CatalogToolbarProps) {
  const { dict } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useState(inStock);
  const [shown, setShown] = useState(inStock);
  // A new server value (navigation finished, or back/forward) wins over the optimistic one.
  if (shown !== inStock) {
    setShown(inStock);
    setOptimistic(inStock);
  }

  const toggle = (next: boolean) => {
    setOptimistic(next);
    startTransition(() => router.push(listingHref(basePath, { sort, inStock: next }, params)));
  };

  return (
    <div
      data-testid="catalog-toolbar"
      aria-busy={pending || undefined}
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2"
    >
      <p className="min-w-0 text-sm text-muted-foreground [overflow-wrap:anywhere]">
        {lead === undefined ? null : (
          <>
            {lead}
            {' · '}
          </>
        )}
        <span data-testid="catalog-count" className="tabular-nums">
          {formatMessage(dict.catalog.productsCount, { count: total })}
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StockSwitch checked={optimistic} onChange={toggle} label={dict.catalog.inStockOnly} />
        <SortSelect
          value={sort}
          basePath={basePath}
          params={optimistic ? { ...params, stock: '1' } : params}
        />
      </div>
    </div>
  );
}

interface StockSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}

/**
 * A drawn switch over a real (visually hidden) checkbox with `role="switch"`, so Space toggles it,
 * screen readers announce "on/off", and the 44px label is the hit area. The thumb slides with
 * `transform` only; reduced motion drops the slide.
 */
function StockSwitch({ checked, onChange, label }: StockSwitchProps) {
  return (
    <label
      className={
        'group inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl px-1 text-sm font-medium select-none ' +
        'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus'
      }
    >
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        className={
          'relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border-2 border-transparent bg-border-strong ' +
          'transition-colors duration-150 group-has-checked:bg-primary motion-reduce:transition-none'
        }
      >
        <span
          className={
            'size-5 rounded-full bg-surface shadow-sm transition-transform duration-150 ease-out-strong ' +
            'group-has-checked:translate-x-4 motion-reduce:transition-none'
          }
        />
      </span>
      <span>{label}</span>
    </label>
  );
}
