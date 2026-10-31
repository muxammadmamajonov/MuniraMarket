import { cx } from '@muniramarket/ui';
import { useI18n } from '@/i18n/context';

/** Read-only "Active / Inactive" badge (the interactive version is a toggle button). */
export function ActivePill({ active }: { active: boolean }) {
  const { dict } = useI18n();
  return (
    <span
      data-active={active}
      className={cx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-medium whitespace-nowrap',
        active
          ? 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200'
          : 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-200',
      )}
    >
      {active ? dict.common.active : dict.common.inactive}
    </span>
  );
}
