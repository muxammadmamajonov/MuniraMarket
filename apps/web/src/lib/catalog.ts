import {
  PRODUCT_SORTS,
  type CategoryNode,
  type Locale,
  type ProductSort,
  type ProductSummary,
} from '@muniramarket/contracts';
import { formatMessage } from '@/i18n/format';
import type { Dictionary } from '@/i18n';

/** Name in the page language (`name_uz` / `name_ru`). */
export function localizedName(item: { name_uz: string; name_ru: string }, locale: Locale): string {
  return locale === 'ru' ? item.name_ru : item.name_uz;
}

export function localizedDescription(
  item: { description_uz: string | null; description_ru: string | null },
  locale: Locale,
): string | null {
  const text = locale === 'ru' ? item.description_ru : item.description_uz;
  return text !== null && text.trim() !== '' ? text : null;
}

/** Path from the root to the category with `slug` (inclusive), or `null` when it is not in the tree. */
export function findCategoryPath(tree: CategoryNode[], slug: string): CategoryNode[] | null {
  for (const node of tree) {
    if (node.slug === slug) return [node];
    const below = findCategoryPath(node.children, slug);
    if (below !== null) return [node, ...below];
  }
  return null;
}

/** Validates the `sort` query parameter; anything unknown falls back to the API default. */
export function parseSort(value: string | string[] | undefined): ProductSort {
  const first = Array.isArray(value) ? value[0] : value;
  return (PRODUCT_SORTS as readonly string[]).includes(first ?? '')
    ? (first as ProductSort)
    : 'newest';
}

/** Validates the `page` query parameter: a positive integer, default 1. */
export function parsePage(value: string | string[] | undefined): number {
  const first = Array.isArray(value) ? value[0] : value;
  const parsed = Number(first);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1;
}

/** A single string search parameter (`?q=a&q=b` -> `a`). */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Stock states shown on cards and the product page. */
export type StockState = { kind: 'out' } | { kind: 'low'; count: number } | { kind: 'in' };

/** Below this many units a tracked product is flagged "only N left". */
const LOW_STOCK_THRESHOLD = 5;

export function stockState(
  product: Pick<ProductSummary, 'in_stock' | 'stock_quantity'>,
): StockState {
  if (!product.in_stock) return { kind: 'out' };
  const quantity = product.stock_quantity;
  if (quantity !== null && quantity <= LOW_STOCK_THRESHOLD) return { kind: 'low', count: quantity };
  return { kind: 'in' };
}

export function stockLabel(state: StockState, dict: Dictionary): string {
  switch (state.kind) {
    case 'out':
      return dict.product.outOfStock;
    case 'low':
      return formatMessage(dict.product.lowStock, { count: state.count });
    case 'in':
      return dict.product.inStock;
  }
}

/** Largest quantity the stepper may offer: the 99-per-line cap, or the tracked stock if lower. */
export const MAX_LINE_QUANTITY = 99;

export function maxQuantityFor(product: Pick<ProductSummary, 'stock_quantity'>): number {
  const stock = product.stock_quantity;
  return stock === null ? MAX_LINE_QUANTITY : Math.max(1, Math.min(MAX_LINE_QUANTITY, stock));
}
