import { describe, expect, it } from 'vitest';
import { category, product, subcategory } from '@/test-utils/fixtures';
import {
  buildCreateRequest,
  buildUpdateRequest,
  categoryTree,
  descendantIds,
  emptyProductForm,
  indentedLabel,
  isValidImageUrl,
  productToForm,
  validateProductForm,
} from './catalog';
import { slugFromSku } from './slug';

const valid = () => ({
  ...emptyProductForm(),
  sku: 'A-1',
  slug: 'a-1',
  name_uz: 'Olma',
  name_ru: 'Яблоко',
  category_id: 'c',
  price: '1000',
});

describe('categoryTree', () => {
  it('orders depth-first by sort_order then name, and shows orphans as roots', () => {
    const items = [
      subcategory({ sort_order: 2 }),
      category({ sort_order: 1 }),
      subcategory({ id: 'x', slug: 'pears', name_uz: 'Nok', sort_order: 1 }),
      category({ id: 'orphan', parent_id: 'missing', name_uz: 'Yetim', sort_order: 9 }),
    ];
    const rows = categoryTree(items, 'uz').map((row) => [row.category.name_uz, row.depth]);
    expect(rows).toEqual([
      ['Mevalar', 0],
      ['Nok', 1],
      ['Olmalar', 1],
      ['Yetim', 0],
    ]);
  });

  it('survives a cycle and finds descendants', () => {
    const a = category({ id: 'a', parent_id: 'b' });
    const b = category({ id: 'b', parent_id: 'a', slug: 'b' });
    expect(categoryTree([a, b], 'uz').length).toBeLessThanOrEqual(2);
    expect([...descendantIds([category(), subcategory()], category().id)].sort()).toHaveLength(2);
    expect(indentedLabel('X', 2)).toBe('  ↳ X');
  });
});

describe('product form rules', () => {
  it('accepts a valid form and turns empty optionals into null', () => {
    expect(validateProductForm(valid())).toEqual({});
    expect(buildCreateRequest(valid())).toMatchObject({
      old_price_uzs: null,
      stock_quantity: null,
      description_uz: null,
      image_url: null,
      price_uzs: 1000,
    });
  });

  it.each([
    [{ price: '1 000.5' }, 'price_uzs'],
    [{ price: '-1' }, 'price_uzs'],
    [{ price: '1000000000001' }, 'price_uzs'],
    [{ old_price: '1000' }, 'old_price_uzs'],
    [{ old_price: '900' }, 'old_price_uzs'],
    [{ stock: '1000001' }, 'stock_quantity'],
    [{ sku: '-bad' }, 'sku'],
    [{ slug: 'Bad_Slug' }, 'slug'],
    [{ name_uz: 'a\nb' }, 'name_uz'],
    [{ name_ru: ' ' }, 'name_ru'],
    [{ image_url: 'http://example.com/a.png' }, 'image_url'],
    [{ category_id: '' }, 'category_id'],
  ])('rejects %j', (patch, field) => {
    expect(validateProductForm({ ...valid(), ...patch })).toHaveProperty(field);
  });

  it('sends only the changed fields on update, including clears', () => {
    const original = product({ old_price_uzs: 40_000, stock_quantity: 25 });
    const values = { ...productToForm(original), price: '31000', old_price: '', stock: '25' };
    expect(buildUpdateRequest(values, original)).toEqual({ price_uzs: 31000, old_price_uzs: null });
    expect(buildUpdateRequest(productToForm(original), original)).toEqual({});
  });

  it('suggests slugs from SKUs and mirrors the API image rules', () => {
    expect(slugFromSku('MILK_1.5L')).toBe('milk-1-5l');
    expect(slugFromSku(' --A  B-- ')).toBe('a-b');
    expect(slugFromSku('')).toBe('');
    for (const ok of ['https://cdn.example.com/a.png', 'https://example.com:443/x?y=1']) {
      expect(isValidImageUrl(ok)).toBe(true);
    }
    for (const bad of [
      'http://example.com/a.png',
      'https://localhost/a.png',
      'https://127.0.0.1/a.png',
      'https://[::1]/a',
      'https://user:pw@example.com/a',
      'https://example.com:8443/a',
      'https://printer.local/a',
      'https://exa mple.com/a',
      'https://пример.рф/a',
      'https://example/a',
      `https://example.com/${'a'.repeat(2048)}`,
    ]) {
      expect(isValidImageUrl(bad)).toBe(false);
    }
  });
});
