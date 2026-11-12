import type { ProductSummary } from '@muniramarket/contracts';
import { ProductTile } from './product-tile';

export interface ProductGridProps {
  products: ProductSummary[];
  label: string;
}

/**
 * Responsive product grid: 2 columns from 320px up (the card is built to fit 138px), 3 and 4 on
 * wider screens. Cards stretch to the tallest in their row; the cart control stays at the bottom.
 */
export function ProductGrid({ products, label }: ProductGridProps) {
  return (
    <ul
      aria-label={label}
      className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 md:grid-cols-4"
    >
      {products.map((product) => (
        <li key={product.id} className="flex min-w-0">
          <ProductTile product={product} />
        </li>
      ))}
    </ul>
  );
}
