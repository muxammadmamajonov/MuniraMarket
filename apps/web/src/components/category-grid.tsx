import type { CategoryNode, Locale } from '@muniramarket/contracts';
import Link from 'next/link';
import { localizedName } from '@/lib/catalog';
import { CategoryIcon, categoryIconFor } from './category-icons';
import { ChevronRightIcon } from './icons';
import { FOCUS_RING, PRESS } from './ui-classes';

export interface CategoryGridProps {
  categories: CategoryNode[];
  locale: Locale;
  label: string;
}

/**
 * Every top-level category as a row with its line icon (one column on phones, two from `sm`,
 * three from `lg`). Names wrap to two lines and long single words break, so a staff-entered name
 * never widens the page. Plain links: no JavaScript needed, keyboard order is reading order.
 */
export function CategoryGrid({ categories, locale, label }: CategoryGridProps) {
  return (
    <nav aria-label={label}>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {categories.map((category) => (
          <li key={category.id} className="min-w-0">
            <Link
              href={`/${locale}/c/${encodeURIComponent(category.slug)}`}
              prefetch={false}
              data-testid="catalog-category"
              className={`flex min-h-16 items-center gap-3 rounded-2xl border border-border bg-surface p-2.5 hover:bg-surface-muted ${PRESS} ${FOCUS_RING}`}
            >
              <span
                aria-hidden="true"
                className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand-ink"
              >
                <CategoryIcon kind={categoryIconFor(category.slug)} className="size-6" />
              </span>
              <span data-user-text className="line-clamp-2 min-w-0 flex-1 font-medium">
                {localizedName(category, locale)}
              </span>
              <ChevronRightIcon aria-hidden="true" className="shrink-0 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
