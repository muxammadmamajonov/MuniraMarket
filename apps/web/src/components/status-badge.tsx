import type { OrderStatus } from '@muniramarket/contracts';
import { cx } from '@muniramarket/ui';

/** Brand-token tones, no green: in-flight states neutral or amber, delivered charcoal, new and cancelled red. */
const TONES: Record<OrderStatus, string> = {
  NEW: 'bg-brand-soft text-brand-ink',
  CONFIRMED: 'bg-surface-muted text-foreground',
  PICKING: 'bg-warning-soft text-warning',
  READY_FOR_DELIVERY: 'bg-surface-muted text-foreground',
  OUT_FOR_DELIVERY: 'bg-warning-soft text-warning',
  DELIVERED: 'bg-foreground text-background',
  CANCELLED: 'bg-danger-soft text-danger',
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
        'inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[13px] leading-5 font-semibold',
        TONES[status],
        className,
      )}
    >
      {label}
    </span>
  );
}
