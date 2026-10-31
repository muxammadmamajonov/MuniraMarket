'use client';

import Link from 'next/link';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';

const LINK =
  'inline-flex min-h-11 items-center rounded-xl border border-border bg-surface px-4 font-medium transition-[background-color,transform] duration-150 ease-out hover:bg-surface-muted active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
const OFF =
  'inline-flex min-h-11 items-center rounded-xl border border-border px-4 font-medium opacity-50';

/** Previous / next links for a list whose page lives in the URL. `hrefFor` builds the link of a page. */
export function Pagination({
  page,
  totalPages,
  hrefFor,
}: {
  page: number;
  totalPages: number;
  hrefFor: (page: number) => string;
}) {
  const { dict } = useI18n();
  const copy = dict.common.pagination;
  if (totalPages <= 1 && page <= 1) return null;
  return (
    <nav aria-label={copy.label} className="flex flex-wrap items-center justify-between gap-3">
      {page > 1 ? (
        <Link href={hrefFor(page - 1)} rel="prev" className={LINK}>
          {copy.previous}
        </Link>
      ) : (
        <span aria-disabled="true" className={OFF}>
          {copy.previous}
        </span>
      )}
      <span aria-live="polite" className="text-muted-foreground tabular">
        {formatMessage(copy.pageOf, { page, total: Math.max(totalPages, 1) })}
      </span>
      {page < totalPages ? (
        <Link href={hrefFor(page + 1)} rel="next" className={LINK}>
          {copy.next}
        </Link>
      ) : (
        <span aria-disabled="true" className={OFF}>
          {copy.next}
        </span>
      )}
    </nav>
  );
}
