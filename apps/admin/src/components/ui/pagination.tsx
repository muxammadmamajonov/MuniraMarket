'use client';

import Link from 'next/link';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { LINK_BUTTON } from './classes';

const LINK = LINK_BUTTON;
const OFF =
  'inline-flex min-h-11 items-center rounded-2xl bg-surface/60 px-4 font-semibold text-muted-foreground';

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
