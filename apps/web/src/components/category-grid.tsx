import type { CategoryNode, Locale } from '@muniramarket/contracts';
import Link from 'next/link';
import { localizedName } from '@/lib/catalog';
import { PHOTO_SIZES } from '@/lib/photo';
import { toneFor } from '@/lib/placeholder';
import { CategoryIcon, categoryIconFor } from './category-icons';
import { ProductImage } from './product-image';
import { FOCUS_RING, PRESS } from './ui-classes';

export interface CategoryGridProps {
  categories: CategoryNode[];
  locale: Locale;
  label: string;
}

/**
 * The catalog as a mosaic of large tinted tiles: each category in its own tone (the same family
 * its products' placeholders and its page header use, see `lib/placeholder.ts`), the name at the
 * top left, the category photo (or, without one, a large line icon) in the bottom right. Two columns on phones (the first tile spans
 * both, so the grid never starts as a plain table), three from `sm`, four from `lg`. Names wrap
 * to three lines and long single words break, so a staff-entered name never widens the page.
 * Plain links: no JavaScript needed, keyboard order is reading order.
 */
export function CategoryGrid({ categories, locale, label }: CategoryGridProps) {
  return (
    <nav aria-label={label}>
      <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {categories.map((category, index) => {
          const wide = index === 0 && categories.length > 2;
          const name = localizedName(category, locale);
          const photo = category.image_url !== null && category.image_url !== '';
          return (
            <li key={category.id} className={`min-w-0 ${wide ? 'col-span-2' : ''}`}>
              <Link
                href={`/${locale}/c/${encodeURIComponent(category.slug)}`}
                prefetch={false}
                data-testid="catalog-category"
                className={`mm-tone-${String(toneFor(category.id))} relative flex flex-col overflow-hidden rounded-[20px] bg-(--tone-bg) p-3.5 ${photo ? 'h-36 sm:h-40' : 'h-32 sm:h-36'} ${PRESS} ${FOCUS_RING}`}
              >
                <span
                  data-user-text
                  className={`relative z-10 text-[15px] leading-5 font-semibold text-foreground text-balance ${photo ? 'line-clamp-2' : 'line-clamp-3'} ${wide ? 'max-w-[60%]' : ''}`}
                >
                  {name}
                </span>
                {photo ? (
                  // Decorative: the link is already named by the text above.
                  <span
                    aria-hidden="true"
                    className={`absolute ${wide ? 'right-3 bottom-3 w-[104px] sm:w-[116px]' : 'right-2.5 bottom-2.5 w-[76px] sm:w-[88px]'}`}
                  >
                    <ProductImage
                      src={category.image_url}
                      name={name}
                      toneKey={category.id}
                      sizes={PHOTO_SIZES.category}
                      className="rounded-2xl shadow-[0_4px_14px_rgb(20_20_22/0.10)]"
                    />
                  </span>
                ) : (
                  <span
                    aria-hidden="true"
                    className={`absolute text-(--tone-fg) ${wide ? '-right-1 -bottom-3 [&_svg]:size-28 [&_svg]:stroke-[1.1]' : '-right-2 -bottom-3 [&_svg]:size-20 [&_svg]:stroke-[1.3]'}`}
                  >
                    <CategoryIcon kind={categoryIconFor(category.slug)} />
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
