import type { OrderStatus } from '@muniramarket/contracts';
import { cx } from '@muniramarket/ui';
import { useI18n } from '@/i18n/context';

// The label always carries the meaning; colour only helps scanning a long list.
const TONES: Record<OrderStatus, string> = {
  NEW: 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200',
  CONFIRMED: 'bg-indigo-100 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200',
  PICKING: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  READY_FOR_DELIVERY: 'bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200',
  OUT_FOR_DELIVERY: 'bg-cyan-100 text-cyan-900 dark:bg-cyan-950 dark:text-cyan-200',
  DELIVERED: 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200',
  CANCELLED: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  const { dict } = useI18n();
  return (
    <span
      data-status={status}
      className={cx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-medium whitespace-nowrap',
        TONES[status],
      )}
    >
      {dict.status[status]}
    </span>
  );
}
