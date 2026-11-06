import type { CategoryNode } from '@muniramarket/contracts';
import { describe, expect, it } from 'vitest';
import { getDictionary } from '@/i18n';
import {
  findCategoryPath,
  localizedName,
  maxQuantityFor,
  parsePage,
  parseSort,
  stockLabel,
  stockState,
  listingHref,
  parseInStock,
  previousPrice,
} from './catalog';

function node(slug: string, children: CategoryNode[] = []): CategoryNode {
  return {
    id: slug,
    slug,
    name_uz: slug,
    name_ru: slug,
    image_url: null,
    sort_order: 0,
    children,
  };
}

describe('catalog helpers', () => {
  it('picks the name in the page language', () => {
    const item = { name_uz: 'Olma', name_ru: 'Яблоко' };
    expect(localizedName(item, 'uz')).toBe('Olma');
    expect(localizedName(item, 'ru')).toBe('Яблоко');
  });

  it('finds a category path through the tree', () => {
    const tree = [node('a', [node('b', [node('c')])]), node('d')];
    expect(findCategoryPath(tree, 'c')?.map((n) => n.slug)).toEqual(['a', 'b', 'c']);
    expect(findCategoryPath(tree, 'd')?.map((n) => n.slug)).toEqual(['d']);
    expect(findCategoryPath(tree, 'nope')).toBeNull();
  });

  it('validates sort and page query parameters', () => {
    expect(parseSort('price_asc')).toBe('price_asc');
    expect(parseSort('drop table')).toBe('newest');
    expect(parseSort(undefined)).toBe('newest');
    expect(parseSort(['name', 'x'])).toBe('name');
    expect(parsePage('3')).toBe(3);
    for (const bad of ['0', '-1', '1.5', 'x', '', undefined, '99999999999999999999']) {
      expect(parsePage(bad), String(bad)).toBe(1);
    }
  });

  it('derives the stock state', () => {
    expect(stockState({ in_stock: false, stock_quantity: 0 })).toEqual({ kind: 'out' });
    expect(stockState({ in_stock: true, stock_quantity: 3 })).toEqual({ kind: 'low', count: 3 });
    expect(stockState({ in_stock: true, stock_quantity: 50 })).toEqual({ kind: 'in' });
    expect(stockState({ in_stock: true, stock_quantity: null })).toEqual({ kind: 'in' });
  });

  it('labels stock in both languages', () => {
    expect(stockLabel({ kind: 'out' }, getDictionary('uz'))).toBe('Tugagan');
    expect(stockLabel({ kind: 'low', count: 2 }, getDictionary('ru'))).toBe('Осталось всего 2');
  });

  it('caps the stepper at 99 or the tracked stock', () => {
    expect(maxQuantityFor({ stock_quantity: null })).toBe(99);
    expect(maxQuantityFor({ stock_quantity: 500 })).toBe(99);
    expect(maxQuantityFor({ stock_quantity: 4 })).toBe(4);
    expect(maxQuantityFor({ stock_quantity: 0 })).toBe(1);
  });
});

describe('listing state', () => {
  it('parses the in-stock flag strictly', () => {
    expect(parseInStock('1')).toBe(true);
    expect(parseInStock(['1', '0'])).toBe(true);
    for (const value of [undefined, '', '0', 'true', 'yes'])
      expect(parseInStock(value)).toBe(false);
  });

  it('builds listing URLs with defaults left out and pagination reset', () => {
    expect(listingHref('/uz/c/fruit', { sort: 'newest', inStock: false })).toBe('/uz/c/fruit');
    expect(listingHref('/uz/c/fruit', { sort: 'price_asc', inStock: true })).toBe(
      '/uz/c/fruit?sort=price_asc&stock=1',
    );
    expect(
      listingHref('/ru/search', { sort: 'newest', inStock: true, page: 3 }, { q: 'olma' }),
    ).toBe('/ru/search?q=olma&stock=1&page=3');
  });
});

describe('previousPrice', () => {
  it('shows an old price only when the data has a higher one', () => {
    expect(previousPrice({ price_uzs: 10_000, old_price_uzs: 12_000 })).toBe(12_000);
    expect(previousPrice({ price_uzs: 10_000, old_price_uzs: null })).toBeNull();
    expect(previousPrice({ price_uzs: 10_000, old_price_uzs: 10_000 })).toBeNull();
    expect(previousPrice({ price_uzs: 10_000, old_price_uzs: 9_000 })).toBeNull();
  });
});
