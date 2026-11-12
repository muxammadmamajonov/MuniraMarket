import type { CategoryNode, Locale } from '@muniramarket/contracts';
import Link from 'next/link';
import { localizedName } from '@/lib/catalog';

export interface CategoryChipsProps {
  categories: CategoryNode[];
  locale: Locale;
  label: string;
  /** Slug to highlight. */
  activeSlug?: string;
}

/**
 * Category links as pills on one swipeable line (the rail snaps, never chains its scroll into the
 * page, and bleeds to the screen edges so the cut-off pill shows there is more).
 */
export function CategoryChips({ categories, locale, label, activeSlug }: CategoryChipsProps) {
  if (categories.length === 0) return null;
  return (
    <nav aria-label={label}>
      <ul className="mm-rail -mx-4 flex scroll-px-4 gap-2 px-4 py-0.5 sm:-mx-6 sm:scroll-px-6 sm:px-6">
        {categories.map((category) => {
          const active = category.slug === activeSlug;
          return (
            <li key={category.id} className="shrink-0">
              <Link
                href={`/${locale}/c/${encodeURIComponent(category.slug)}`}
                aria-current={active ? 'true' : undefined}
                className={
                  'inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold whitespace-nowrap ' +
                  'transition-transform duration-150 ease-out-strong active:scale-[0.97] motion-reduce:transition-none ' +
                  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ' +
                  (active ? 'bg-foreground text-background' : 'bg-surface hover:bg-surface-muted')
                }
              >
                {localizedName(category, locale)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
