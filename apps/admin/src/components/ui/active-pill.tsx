import { cx } from '@muniramarket/ui';
import { useI18n } from '@/i18n/context';

/** Read-only "Active / Inactive" badge (the interactive version is a toggle button). */
export function ActivePill({ active }: { active: boolean }) {
  const { dict } = useI18n();
  return (
    <span
      data-active={active}
      className={cx(
        'inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-[13px] leading-5 font-semibold whitespace-nowrap',
        active
          ? 'bg-success-soft text-success'
          : 'bg-surface-muted text-muted-foreground ring-1 ring-border ring-inset',
      )}
    >
      {active ? dict.common.active : dict.common.inactive}
    </span>
  );
}
