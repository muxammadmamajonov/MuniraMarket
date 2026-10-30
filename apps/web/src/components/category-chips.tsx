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

/** Horizontally wrapping category links. */
export function CategoryChips({ categories, locale, label, activeSlug }: CategoryChipsProps) {
  if (categories.length === 0) return null;
  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap gap-2">
        {categories.map((category) => {
          const active = category.slug === activeSlug;
          return (
            <li key={category.id}>
              <Link
                href={`/${locale}/c/${encodeURIComponent(category.slug)}`}
                aria-current={active ? 'true' : undefined}
                className={
                  'inline-flex min-h-11 items-center rounded-full border border-border px-4 text-sm font-medium ' +
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ' +
                  (active
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-surface hover:bg-surface-muted')
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
