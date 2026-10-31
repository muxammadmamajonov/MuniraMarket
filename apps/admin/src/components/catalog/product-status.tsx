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
  active: 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200',
  inactive: 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-200',
  archived: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
};

export function ProductStatusBadge({ state }: { state: ProductState }) {
  const { dict } = useI18n();
  return (
    <span
      data-state={state}
      className={cx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-medium whitespace-nowrap',
        TONES[state],
      )}
    >
      {dict.products.badge[state]}
    </span>
  );
}
