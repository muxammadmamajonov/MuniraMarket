import type { CategoryNode, Locale } from '@muniramarket/contracts';
import Link from 'next/link';
import { localizedName } from '@/lib/catalog';
import { PHOTO_SIZES } from '@/lib/photo';
import { toneFor } from '@/lib/placeholder';
import { CategoryIcon, categoryIconFor } from './category-icons';
import { ProductImage } from './product-image';
import { FOCUS_RING, PRESS } from './ui-classes';

export interface CategoryRailProps {
  categories: CategoryNode[];
  locale: Locale;
  label: string;
  /** Slug of the category being viewed (its tile is filled and marked `aria-current`). */
  activeSlug?: string | undefined;
}

/**
 * Horizontally scrollable category shortcuts: the category photo, or without one a tile in the
 * category's own tint (the same family its products' placeholders use, see `lib/placeholder.ts`)
 * with its line icon; the name under it (clamped to two lines; the category page shows it in
 * full). The current category's photo gets a red ring, its icon tile a red fill. Plain
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
          const photo = category.image_url !== null && category.image_url !== '';
          return (
            <li key={category.id} className="shrink-0">
              <Link
                href={`/${locale}/c/${encodeURIComponent(category.slug)}`}
                prefetch={false}
                aria-current={active ? 'page' : undefined}
                className={`group flex w-[84px] flex-col items-center gap-1.5 rounded-2xl p-1.5 sm:w-[104px] ${PRESS} ${FOCUS_RING}`}
              >
                {photo ? (
                  <span
                    aria-hidden="true"
                    className={`block size-16 rounded-[22px] ring-offset-2 ring-offset-background transition-shadow duration-150 ${
                      active
                        ? 'ring-2 ring-primary'
                        : 'group-hover:ring-2 group-hover:ring-primary/40'
                    }`}
                  >
                    <ProductImage
                      src={category.image_url}
                      name={name}
                      toneKey={category.id}
                      sizes={PHOTO_SIZES.category}
                      className="rounded-[22px]"
                    />
                  </span>
                ) : (
                  <span
                    aria-hidden="true"
                    className={`flex size-16 items-center justify-center rounded-[22px] transition-colors duration-150 ${
                      active
                        ? 'bg-primary text-primary-foreground'
                        : `mm-tone-${String(toneFor(category.id))} bg-(--tone-bg) text-(--tone-fg) group-hover:bg-primary group-hover:text-primary-foreground`
                    }`}
                  >
                    <CategoryIcon kind={categoryIconFor(category.slug)} className="size-7" />
                  </span>
                )}
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
