import type { OrderStatus } from '@muniramarket/contracts';
import { cx } from '@muniramarket/ui';
import { useI18n } from '@/i18n/context';

// The label always carries the meaning; colour only helps scanning a long list.
const TONES: Record<OrderStatus, string> = {
  // New orders need attention first: the brand's own red tint.
  NEW: 'bg-brand-soft text-brand-ink ring-1 ring-brand-ink/30 ring-inset',
  CONFIRMED: 'bg-indigo-100 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200',
  PICKING: 'bg-warning-soft text-warning',
  READY_FOR_DELIVERY: 'bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200',
  OUT_FOR_DELIVERY: 'bg-cyan-100 text-cyan-900 dark:bg-cyan-950 dark:text-cyan-200',
  DELIVERED: 'bg-success-soft text-success',
  CANCELLED: 'bg-danger-soft text-danger',
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
