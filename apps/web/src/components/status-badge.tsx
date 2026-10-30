import type { OrderStatus } from '@muniramarket/contracts';
import { cx } from '@muniramarket/ui';

const TONES: Record<OrderStatus, string> = {
  NEW: 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200',
  CONFIRMED: 'bg-indigo-100 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200',
  PICKING: 'bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-200',
  READY_FOR_DELIVERY: 'bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200',
  OUT_FOR_DELIVERY: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200',
  DELIVERED: 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200',
  CANCELLED: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
};

export interface StatusBadgeProps {
  status: OrderStatus;
  /** Already localized status name. The text, not just the colour, carries the meaning. */
  label: string;
  className?: string;
}

/** Order status pill. Never wraps or shrinks; its neighbours give way instead. */
export function StatusBadge({ status, label, className }: StatusBadgeProps) {
  return (
    <span
      data-status={status}
      className={cx(
        'inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2.5 py-1 text-sm font-semibold',
        TONES[status],
        className,
      )}
    >
      {label}
    </span>
  );
}
