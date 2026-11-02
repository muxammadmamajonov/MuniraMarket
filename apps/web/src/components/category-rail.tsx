import type { CategoryNode, Locale } from '@muniramarket/contracts';
import Link from 'next/link';
import { localizedName } from '@/lib/catalog';
import { CategoryIcon, categoryIconFor } from './category-icons';
import { FOCUS_RING, PRESS } from './ui-classes';

export interface CategoryRailProps {
  categories: CategoryNode[];
  locale: Locale;
  label: string;
  /** Slug of the category being viewed (its tile is filled and marked `aria-current`). */
  activeSlug?: string | undefined;
}

/**
 * Horizontally scrollable category shortcuts: a soft brand-tinted tile with the category's line
 * icon and the name under it (clamped to two lines; the category page shows it in full). Plain
 * links in a list (so they work without JavaScript and by keyboard); the scrollbar is hidden, the
 * rail snaps and does not chain its scroll into the page.
 */
export function CategoryRail({ categories, locale, label, activeSlug }: CategoryRailProps) {
  if (categories.length === 0) return null;
  return (
    <nav aria-label={label}>
      <ul className="mm-rail -mx-4 flex gap-1 scroll-pl-1 py-1 pr-4 pl-1 sm:-mx-6 sm:scroll-pl-[13px] sm:pr-6 sm:pl-[13px]">
        {categories.map((category) => {
          const name = localizedName(category, locale);
          const active = category.slug === activeSlug;
          return (
            <li key={category.id} className="shrink-0">
              <Link
                href={`/${locale}/c/${encodeURIComponent(category.slug)}`}
                prefetch={false}
                aria-current={active ? 'page' : undefined}
                className={`group flex w-[78px] flex-col items-center gap-1.5 rounded-2xl p-1.5 sm:w-[104px] ${PRESS} ${FOCUS_RING}`}
              >
                <span
                  aria-hidden="true"
                  className={`flex size-14 items-center justify-center rounded-2xl transition-colors duration-150 ${
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-brand-soft text-brand-ink group-hover:bg-primary group-hover:text-primary-foreground'
                  }`}
                >
                  <CategoryIcon kind={categoryIconFor(category.slug)} className="size-7" />
                </span>
                <span
                  data-user-text
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
