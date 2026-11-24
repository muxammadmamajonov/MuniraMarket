import { cx } from '@muniramarket/ui';
import type { ReactNode } from 'react';
import { useIsPhone } from '@/lib/use-phone';
import { GROUP, ROWS } from './classes';

export interface Column<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Right-aligned (numbers, amounts). */
  numeric?: boolean;
  /** Never wrap (amounts, dates, codes): they need their room. */
  nowrap?: boolean;
  /** Hidden on phones, where each row is a card (low-value columns). */
  desktopOnly?: boolean;
  /** The row's title: on phones it leads the card, left-aligned and without its label. */
  primary?: boolean;
  /** Phones: no label, left-aligned, full width (action buttons). */
  bare?: boolean;
}

// On phones each row is a card and cells get their label from `data-label`; from `sm` up it is a
// regular table. `min-w-0` + `break-words` keep long names from pushing siblings out of the row.
const CELL =
  'flex min-w-0 justify-between gap-3 py-1 before:shrink-0 before:text-sm before:text-muted-foreground ' +
  'before:content-[attr(data-label)] sm:table-cell sm:px-3 sm:py-3 sm:before:hidden';

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  rowTestId,
  mobileRow,
}: {
  columns: ReadonlyArray<Column<T>>;
  rows: readonly T[];
  rowKey: (row: T) => string;
  caption: string;
  rowTestId?: string;
  /**
   * Phones: render each row as a native list row (content first, no label/value pairs) inside
   * one white group. Without it, phones get one card per row with labelled cells.
   */
  mobileRow?: (row: T) => ReactNode;
}) {
  const phone = useIsPhone();
  if (phone && mobileRow !== undefined) {
    return (
      <ul aria-label={caption} className={cx(GROUP, ROWS, 'overflow-hidden')}>
        {rows.map((row) => (
          <li key={rowKey(row)} data-testid={rowTestId}>
            {mobileRow(row)}
          </li>
        ))}
      </ul>
    );
  }
  return (
    // Desktop: one white group, rows split by an inset hairline. Phones: each row is its own
    // white card on the page (the group wrapper steps aside with `contents`).
    <div className="max-sm:contents sm:overflow-hidden sm:rounded-3xl sm:bg-surface sm:px-2">
      <table className="block w-full text-left sm:table">
        <caption className="sr-only">{caption}</caption>
        <thead className="hidden sm:table-header-group">
          <tr className="border-b border-hairline text-[13px] text-muted-foreground">
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={cx('px-3 pt-3.5 pb-2.5 font-medium', column.numeric && 'text-right')}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="block sm:table-row-group">
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              data-testid={rowTestId}
              className="mb-2.5 block rounded-3xl bg-surface px-4 py-3 sm:mb-0 sm:table-row sm:rounded-none sm:border-b sm:border-hairline sm:bg-transparent sm:px-0 sm:py-0 sm:last:border-b-0 sm:hover:bg-surface-muted/60"
            >
              {columns.map((column) => (
                <td
                  key={column.id}
                  data-label={column.header}
                  className={cx(
                    CELL,
                    'sm:align-middle',
                    column.numeric && 'sm:text-right',
                    column.nowrap ? 'sm:whitespace-nowrap' : 'break-words [overflow-wrap:anywhere]',
                    column.desktopOnly && 'max-sm:hidden',
                    (column.primary || column.bare) && 'max-sm:justify-start max-sm:before:hidden',
                  )}
                >
                  <span className={cx('min-w-0', column.numeric && 'text-right sm:text-inherit')}>
                    {column.cell(row)}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
