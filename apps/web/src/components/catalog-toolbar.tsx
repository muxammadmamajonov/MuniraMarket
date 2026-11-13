'use client';

import type { ProductSort } from '@muniramarket/contracts';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { listingHref } from '@/lib/catalog';
import { BottomSheet } from './bottom-sheet';
import { SortSelect } from './sort-select';
import { FOCUS_RING, PRESS } from './ui-classes';

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
 * The "in stock only" chip and the sort pill on one line above a product grid, the count under
 * them. Both controls
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
  const [sheetOpen, setSheetOpen] = useState(false);
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
      className="flex flex-col gap-2"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {/* Phones: filters live behind one "Filter" button (a bottom sheet); wider screens keep
            the switch inline. Sorting stays one tap away on both. */}
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          data-testid="catalog-filter-button"
          onClick={() => setSheetOpen(true)}
          className={
            'inline-flex min-h-11 items-center gap-2 rounded-full py-2 pr-4 pl-3 text-sm font-semibold md:hidden ' +
            (optimistic ? 'bg-foreground text-background ' : 'bg-surface ') +
            `${PRESS} ${FOCUS_RING}`
          }
        >
          <FilterGlyph />
          {dict.catalog.filterLabel}
          {optimistic ? (
            <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs leading-5 font-bold text-primary-foreground">
              1
            </span>
          ) : null}
        </button>
        <span className="max-md:hidden">
          <StockSwitch checked={optimistic} onChange={toggle} label={dict.catalog.inStockOnly} />
        </span>
        <SortSelect
          value={sort}
          basePath={basePath}
          params={optimistic ? { ...params, stock: '1' } : params}
        />
      </div>
      <BottomSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={dict.catalog.filterLabel}
        closeLabel={dict.catalog.closeFilters}
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3 rounded-2xl bg-surface-muted px-4 py-3">
            <span className="font-semibold">{dict.catalog.inStockOnly}</span>
            <SheetSwitch checked={optimistic} onChange={toggle} label={dict.catalog.inStockOnly} />
          </div>
          <button
            type="button"
            onClick={() => setSheetOpen(false)}
            className={`inline-flex min-h-13 items-center justify-center rounded-2xl bg-primary px-6 text-[17px] font-semibold text-primary-foreground hover:bg-primary-hover ${PRESS} ${FOCUS_RING}`}
          >
            {dict.catalog.showResults}
          </button>
        </div>
      </BottomSheet>
      <p className="min-w-0 px-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">
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
    </div>
  );
}

interface StockSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}

/**
 * A filter chip holding a small drawn switch, over a real (visually hidden) checkbox with
 * `role="switch"`, so Space toggles it, screen readers announce "on/off", and the 44px chip is the
 * hit area. On, the chip turns charcoal with a red switch. Reduced motion drops the slide.
 */
function StockSwitch({ checked, onChange, label }: StockSwitchProps) {
  return (
    <label
      className={
        'group inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full bg-surface py-2 pr-3.5 pl-2 text-sm font-semibold whitespace-nowrap select-none ' +
        'transition-[transform,background-color,color] duration-150 ease-out-strong active:scale-[0.97] ' +
        'has-checked:bg-foreground has-checked:text-background motion-reduce:transition-none ' +
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
      {/* A small switch inside the chip: the thumb slides with transform only. */}
      <span
        aria-hidden="true"
        className="relative inline-flex h-5 w-[30px] shrink-0 items-center rounded-full bg-border-strong p-0.5 transition-colors duration-150 group-has-checked:bg-primary motion-reduce:transition-none"
      >
        <span className="size-4 rounded-full bg-white shadow-sm transition-transform duration-150 ease-out-strong group-has-checked:translate-x-2.5 motion-reduce:transition-none" />
      </span>
      <span>{label}</span>
    </label>
  );
}

/** Three lines narrowing down: the filter glyph of the phone "Filter" button. */
function FilterGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="size-[18px]"
    >
      <path d="M4 7h16M7 12h10M10 17h4" />
    </svg>
  );
}

/** The same switch, standing alone in a sheet row (the row's text names it). */
function SheetSwitch({ checked, onChange, label }: StockSwitchProps) {
  return (
    <label className="group relative inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-end has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus">
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        className="relative inline-flex h-[31px] w-[51px] shrink-0 items-center rounded-full bg-border-strong p-0.5 transition-colors duration-150 group-has-checked:bg-primary motion-reduce:transition-none"
      >
        <span className="size-[27px] rounded-full bg-white shadow-[0_2px_4px_rgb(0_0_0/0.2)] transition-transform duration-200 ease-out-strong group-has-checked:translate-x-5 motion-reduce:transition-none" />
      </span>
    </label>
  );
}
