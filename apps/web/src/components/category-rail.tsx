import type { CategoryNode, Locale } from '@muniramarket/contracts';
import Link from 'next/link';
import { localizedName } from '@/lib/catalog';
import { initialOf, toneFor } from '@/lib/placeholder';
import { FOCUS_RING, PRESS } from './ui-classes';

export interface CategoryRailProps {
  categories: CategoryNode[];
  locale: Locale;
  label: string;
}

/**
 * Horizontally scrollable category shortcuts: a tinted initial-letter tile with the name under it.
 * The tint is the one the category's products use for their placeholders. Plain links in a list
 * (so they work without JavaScript and by keyboard); the scrollbar is hidden, the rail snaps and
 * does not chain its scroll into the page.
 */
export function CategoryRail({ categories, locale, label }: CategoryRailProps) {
  if (categories.length === 0) return null;
  return (
    <nav aria-label={label}>
      <ul className="mm-rail -mx-4 flex gap-1 scroll-pl-1 py-1 pr-4 pl-1 sm:-mx-6 sm:scroll-pl-[13px] sm:pr-6 sm:pl-[13px]">
        {categories.map((category) => {
          const name = localizedName(category, locale);
          return (
            <li key={category.id} className="shrink-0">
              <Link
                href={`/${locale}/c/${encodeURIComponent(category.slug)}`}
                prefetch={false}
                className={`flex w-[78px] flex-col sm:w-[104px] items-center gap-1.5 rounded-2xl p-1.5 ${PRESS} ${FOCUS_RING}`}
              >
                <span
                  aria-hidden="true"
                  className={`mm-tone-${String(toneFor(category.id))} flex h-14 w-14 items-center justify-center rounded-2xl bg-(--tone-bg) text-2xl font-semibold text-(--tone-fg)`}
                >
                  {initialOf(name)}
                </span>
                <span
                  data-user-text
                  title={name}
                  className="line-clamp-2 min-h-8 text-center text-xs leading-4 font-medium"
                >
                  {name}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
