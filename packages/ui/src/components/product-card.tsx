import type { Locale } from '@muniramarket/contracts';
import type { ComponentType, ReactNode } from 'react';
import { cx } from '../cx';
import { ImagePlaceholder } from './image-placeholder';
import { Price } from './price';

export interface ProductCardLinkProps {
  href: string;
  className?: string;
  children: ReactNode;
}

export interface ProductCardProps {
  href: string;
  /** Link implementation; pass `next/link` for client-side navigation. Defaults to `<a>`. */
  linkComponent?: ComponentType<ProductCardLinkProps>;
  locale: Locale;
  name: string;
  imageUrl: string | null;
  /** Integer UZS. */
  price: number;
  oldPrice?: number | undefined;
  /** Localized unit, shown as "/ kg" under the price. */
  unitLabel?: string | undefined;
  /** Localized stock note, e.g. "Out of stock". Rendered only when provided. */
  stockLabel?: string | undefined;
  currentPriceLabel?: string | undefined;
  oldPriceLabel?: string | undefined;
  className?: string | undefined;
}

function DefaultLink({ href, className, children }: ProductCardLinkProps) {
  return (
    <a href={href} className={className}>
      {children}
    </a>
  );
}

/** Catalog grid card: image (or placeholder), name, price with optional old price, stock note. */
export function ProductCard({
  href,
  linkComponent: LinkComponent = DefaultLink,
  locale,
  name,
  imageUrl,
  price,
  oldPrice,
  unitLabel,
  stockLabel,
  currentPriceLabel,
  oldPriceLabel,
  className,
}: ProductCardProps) {
  return (
    <LinkComponent
      href={href}
      className={cx(
        'flex flex-col gap-2 rounded-xl border border-border bg-surface p-2 ' +
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        className,
      )}
    >
      <ImagePlaceholder src={imageUrl} alt={name} />
      <span className="line-clamp-2 min-h-10 text-sm font-medium">{name}</span>
      <span className="flex flex-col gap-0.5">
        <Price
          amount={price}
          {...(oldPrice === undefined ? {} : { oldAmount: oldPrice })}
          locale={locale}
          {...(currentPriceLabel === undefined ? {} : { currentLabel: currentPriceLabel })}
          {...(oldPriceLabel === undefined ? {} : { oldLabel: oldPriceLabel })}
        />
        {unitLabel ? <span className="text-xs text-muted-foreground">/ {unitLabel}</span> : null}
      </span>
      {stockLabel ? <span className="text-xs text-muted-foreground">{stockLabel}</span> : null}
    </LinkComponent>
  );
}
