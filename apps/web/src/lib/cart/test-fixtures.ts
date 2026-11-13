import type { Cart, CartLine, ProductSummary } from '@muniramarket/contracts';

/** Test-only builders for products and carts. Not imported by app code. */
export function makeProduct(overrides: Partial<ProductSummary> = {}): ProductSummary {
  return {
    id: 'p1',
    slug: 'demo-olma',
    sku: 'DEMO-0001',
    name_uz: 'Olma',
    name_ru: 'Яблоко',
    unit: 'kg',
    price_uzs: 12500,
    old_price_uzs: null,
    stock_quantity: null,
    in_stock: true,
    low_stock: false,
    image_url: null,
    category_id: 'c1',
    ...overrides,
  };
}

export function makeLine(
  product: ProductSummary,
  quantity: number,
  overrides: Partial<CartLine> = {},
): CartLine {
  return {
    product,
    quantity,
    line_total_uzs: product.price_uzs * quantity,
    issue: null,
    ...overrides,
  };
}

export function makeCart(lines: CartLine[] = []): Cart {
  const counted = lines.filter((line) => line.issue === null);
  const total = counted.reduce((sum, line) => sum + line.line_total_uzs, 0);
  return {
    items: lines,
    item_count: counted.reduce((sum, line) => sum + line.quantity, 0),
    subtotal_uzs: total,
    total_uzs: total,
    has_issues: lines.some((line) => line.issue !== null),
  };
}
