import Link from 'next/link';
import { formatMessage } from '@/i18n/format';
import type { Dictionary } from '@/i18n';

export interface PaginationProps {
  page: number;
  totalPages: number;
  /** Builds the URL of another page, keeping the other query parameters. */
  hrefFor: (page: number) => string;
  dict: Dictionary;
}

const LINK =
  'inline-flex min-h-11 items-center rounded-xl border border-border bg-surface px-4 font-medium ' +
  'hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
const DISABLED =
  'inline-flex min-h-11 items-center rounded-xl px-4 text-muted-foreground opacity-50';

/** Previous / next links (real links, so pagination works without JavaScript and is crawlable). */
export function Pagination({ page, totalPages, hrefFor, dict }: PaginationProps) {
  if (totalPages <= 1) return null;
  const { pagination } = dict.catalog;

  return (
    <nav aria-label={pagination.label} className="flex items-center justify-between gap-3 py-4">
      {page > 1 ? (
        <Link href={hrefFor(page - 1)} rel="prev" className={LINK}>
          {pagination.previous}
        </Link>
      ) : (
        <span aria-hidden="true" className={DISABLED}>
          {pagination.previous}
        </span>
      )}
      <span className="text-sm text-muted-foreground">
        {formatMessage(pagination.position, { page, total: totalPages })}
      </span>
      {page < totalPages ? (
        <Link href={hrefFor(page + 1)} rel="next" className={LINK}>
          {pagination.next}
        </Link>
      ) : (
        <span aria-hidden="true" className={DISABLED}>
          {pagination.next}
        </span>
      )}
    </nav>
  );
}
