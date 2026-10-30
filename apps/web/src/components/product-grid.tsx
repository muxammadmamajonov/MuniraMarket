import type { Locale, ProductSummary } from '@muniramarket/contracts';
import { ProductCard, type ProductCardLinkProps } from '@muniramarket/ui';
import Link from 'next/link';
import type { Dictionary } from '@/i18n';
import { localizedName, stockLabel, stockState } from '@/lib/catalog';

function NextLink({ href, className, children }: ProductCardLinkProps) {
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

export interface ProductGridProps {
  products: ProductSummary[];
  locale: Locale;
  dict: Dictionary;
  label: string;
}

/** Responsive product grid: 2 columns on phones, up to 4 on wide screens. */
export function ProductGrid({ products, locale, dict, label }: ProductGridProps) {
  return (
    <ul aria-label={label} className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
      {products.map((product) => {
        const state = stockState(product);
        return (
          <li key={product.id} className="flex">
            <ProductCard
              className="w-full"
              linkComponent={NextLink}
              href={`/${locale}/p/${encodeURIComponent(product.slug)}`}
              locale={locale}
              name={localizedName(product, locale)}
              imageUrl={product.image_url}
              price={product.price_uzs}
              oldPrice={product.old_price_uzs ?? undefined}
              unitLabel={dict.units[product.unit]}
              stockLabel={state.kind === 'in' ? undefined : stockLabel(state, dict)}
              currentPriceLabel={dict.product.priceCurrentLabel}
              oldPriceLabel={dict.product.priceOldLabel}
            />
          </li>
        );
      })}
    </ul>
  );
}
