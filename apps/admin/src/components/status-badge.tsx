import type { OrderStatus } from '@muniramarket/contracts';
import { cx } from '@muniramarket/ui';
import { useI18n } from '@/i18n/context';

// The label always carries the meaning; colour only helps scanning a long list. The same brand
// tones as the storefront's badge (`apps/web/src/components/status-badge.tsx`), so a customer and
// an operator see one colour per status: in-flight states neutral or amber, delivered charcoal,
// new and cancelled red. New orders also get a ring: they are what staff look for first.
const TONES: Record<OrderStatus, string> = {
  NEW: 'bg-brand-soft text-brand-ink ring-1 ring-brand-ink/30 ring-inset',
  CONFIRMED: 'bg-surface-muted text-foreground',
  PICKING: 'bg-warning-soft text-warning',
  READY_FOR_DELIVERY: 'bg-surface-muted text-foreground ring-1 ring-border-strong/60 ring-inset',
  OUT_FOR_DELIVERY: 'bg-warning-soft text-warning ring-1 ring-warning/30 ring-inset',
  DELIVERED: 'bg-foreground text-background',
  CANCELLED: 'bg-danger-soft text-danger',
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  const { dict } = useI18n();
  return (
    <span
      data-status={status}
      className={cx(
        'inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-[13px] leading-5 font-semibold whitespace-nowrap',
        TONES[status],
      )}
    >
      {dict.status[status]}
    </span>
  );
}
