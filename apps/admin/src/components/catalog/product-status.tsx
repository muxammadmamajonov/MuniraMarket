import type { AdminProduct } from '@muniramarket/contracts';
import { cx } from '@muniramarket/ui';
import { useI18n } from '@/i18n/context';

export type ProductState = 'active' | 'inactive' | 'archived';

export function productState(
  product: Pick<AdminProduct, 'archived_at' | 'is_active'>,
): ProductState {
  if (product.archived_at !== null) return 'archived';
  return product.is_active ? 'active' : 'inactive';
}

const TONES: Record<ProductState, string> = {
  active: 'bg-success-soft text-success',
  inactive: 'bg-surface-muted text-muted-foreground ring-1 ring-border ring-inset',
  archived: 'bg-warning-soft text-warning',
};

export function ProductStatusBadge({ state }: { state: ProductState }) {
  const { dict } = useI18n();
  return (
    <span
      data-state={state}
      className={cx(
        'inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-[13px] leading-5 font-semibold whitespace-nowrap',
        TONES[state],
      )}
    >
      {dict.products.badge[state]}
    </span>
  );
}
