'use client';

import { cx } from '@muniramarket/ui';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n/context';
import { useIsPhone } from '@/lib/use-phone';
import { Modal } from './modal';
import { PRESS } from './classes';

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

function FilterIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      className="size-5"
    >
      <path d="M4 7h16M7 12h10M10 17h4" />
    </svg>
  );
}

/**
 * Filters of a list. Wider screens show them inline (`children`). On phones only the search (or
 * whatever `always` holds) stays on screen, next to a "Filters" button with the number of
 * active filters; the filters themselves open in a bottom sheet, apply as they are tapped (they
 * live in the URL), and "Show results" closes it. The list stays the first thing on screen.
 */
export function FilterSheet({
  always,
  active,
  onReset,
  children,
}: {
  /** Stays visible on phones too (the search field). */
  always?: ReactNode;
  /** How many filters differ from their default. */
  active: number;
  onReset?: () => void;
  children: ReactNode;
}) {
  const { dict } = useI18n();
  const phone = useIsPhone();
  const [opener, setOpener] = useState<HTMLElement | null>(null);

  if (!phone) {
    return (
      <div className="flex flex-col gap-3">
        {always}
        {children}
      </div>
    );
  }

  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1">{always}</div>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={opener !== null}
        data-testid="filters-button"
        onClick={(event) => setOpener(event.currentTarget)}
        className={cx(
          'relative inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-2xl px-3.5 font-semibold',
          'shadow-[0_1px_2px_rgb(20_20_22/0.06)]',
          active > 0 ? 'bg-foreground text-background' : 'bg-surface text-foreground',
          PRESS,
          FOCUS,
        )}
      >
        <FilterIcon />
        {always === undefined ? (
          dict.common.filters
        ) : (
          <span className="sr-only">{dict.common.filters}</span>
        )}
        {active > 0 ? (
          <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs leading-5 font-bold text-primary-foreground tabular">
            {active}
          </span>
        ) : null}
      </button>
      {opener === null ? null : (
        <Modal
          title={dict.common.filters}
          variant="sheet"
          onClose={() => setOpener(null)}
          returnFocusTo={opener}
        >
          {/* `mm-in-sheet`: chips wrap and page-style fields turn filled on the white sheet. */}
          <div className="mm-in-sheet flex flex-col gap-4">
            {children}
            <div className="flex flex-col gap-2 pt-1">
              <button
                type="button"
                onClick={() => setOpener(null)}
                className={cx(
                  'inline-flex min-h-12 items-center justify-center rounded-2xl bg-primary px-5 font-semibold text-primary-foreground hover:bg-primary-hover',
                  PRESS,
                  FOCUS,
                )}
              >
                {dict.common.showResults}
              </button>
              {onReset === undefined || active === 0 ? null : (
                <button
                  type="button"
                  onClick={() => {
                    onReset();
                    setOpener(null);
                  }}
                  className={cx(
                    'inline-flex min-h-11 items-center justify-center rounded-2xl px-5 font-semibold text-brand-ink',
                    FOCUS,
                  )}
                >
                  {dict.common.resetFilters}
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
