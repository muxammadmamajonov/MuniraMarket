import { cx } from '@muniramarket/ui';
import type { ReactNode } from 'react';

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
}: {
  columns: ReadonlyArray<Column<T>>;
  rows: readonly T[];
  rowKey: (row: T) => string;
  caption: string;
  rowTestId?: string;
}) {
  return (
    <table className="block w-full text-left sm:table">
      <caption className="sr-only">{caption}</caption>
      <thead className="hidden sm:table-header-group">
        <tr className="border-b border-border text-sm text-muted-foreground">
          {columns.map((column) => (
            <th
              key={column.id}
              scope="col"
              className={cx('px-3 py-2 font-medium', column.numeric && 'text-right')}
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
            className="mb-3 block rounded-xl border border-border bg-surface px-3 py-2 sm:mb-0 sm:table-row sm:rounded-none sm:border-0 sm:border-b sm:bg-transparent sm:px-0 sm:py-0 sm:hover:bg-surface-muted"
          >
            {columns.map((column) => (
              <td
                key={column.id}
                data-label={column.header}
                className={cx(
                  CELL,
                  'sm:align-top',
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
  );
}
