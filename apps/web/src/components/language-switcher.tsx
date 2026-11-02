'use client';

import { SUPPORTED_LOCALES, type Locale } from '@muniramarket/contracts';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { persistLocale, switchLocalePath } from '@/i18n/switch-locale';

export interface LanguageSwitcherProps {
  locale: Locale;
  /** Accessible name of the navigation landmark, e.g. "Language". */
  label: string;
  /** Native display name of each language. */
  names: Record<Locale, string>;
  /** Short visible labels (for example `UZ`, `RU`) used by the compact variant. */
  shortNames?: Record<Locale, string>;
  /**
   * One button that switches to the other language instead of one link per language: 44px wide, so
   * it fits a 320px header. The full language name stays its accessible name.
   */
  compact?: boolean;
}

/**
 * Links to the same page in each language. Clicking also stores the choice in the `locale`
 * cookie so the proxy honours it on the next visit to `/`.
 */
export function LanguageSwitcher({
  locale,
  label,
  names,
  shortNames = names,
  compact = false,
}: LanguageSwitcherProps) {
  const pathname = usePathname();

  if (compact) {
    const other = SUPPORTED_LOCALES.find((candidate) => candidate !== locale) ?? locale;
    return (
      <nav aria-label={label}>
        <Link
          href={switchLocalePath(pathname, other)}
          lang={other}
          hrefLang={other}
          aria-label={names[other]}
          onClick={() => persistLocale(other)}
          className={
            'inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl px-2.5 text-sm font-semibold ' +
            'hover:bg-surface-muted transition-[transform,background-color] duration-150 ease-out-strong ' +
            'active:scale-[0.97] motion-reduce:transition-none ' +
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'
          }
        >
          {shortNames[other]}
        </Link>
      </nav>
    );
  }

  return (
    <nav aria-label={label}>
      <ul className="flex items-center gap-1">
        {SUPPORTED_LOCALES.map((target) => {
          const active = target === locale;
          return (
            <li key={target}>
              <Link
                href={switchLocalePath(pathname, target)}
                lang={target}
                hrefLang={target}
                aria-current={active ? 'true' : undefined}
                onClick={() => persistLocale(target)}
                className={
                  'inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl px-3 text-sm font-medium ' +
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ' +
                  (active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-foreground hover:bg-surface-muted')
                }
              >
                {names[target]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
