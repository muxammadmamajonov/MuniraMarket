import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CategoryNode } from '@muniramarket/contracts';
import { CategoryGrid } from './category-grid';

function node(id: string, slug: string, name: string): CategoryNode {
  return { id, slug, name_uz: name, name_ru: name, image_url: null, sort_order: 0, children: [] };
}

describe('CategoryGrid', () => {
  it('lays the catalog out as tinted tiles, the first one spanning both phone columns', () => {
    render(
      <CategoryGrid
        categories={[
          node('a', 'demo-mevalar', 'Mevalar'),
          node('b', 'demo-non', 'Non'),
          node('c', 'demo-sut', 'Sut'),
        ]}
        locale="uz"
        label="Katalog"
      />,
    );
    const tiles = screen.getAllByTestId('catalog-category');
    expect(tiles).toHaveLength(3);
    expect(tiles[0]).toHaveAttribute('href', '/uz/c/demo-mevalar');
    expect(tiles[0]?.closest('li')).toHaveClass('col-span-2');
    expect(tiles[1]?.closest('li')).not.toHaveClass('col-span-2');
    // Each tile carries its category tone (the same family as the product placeholders).
    for (const tile of tiles) expect(tile.className).toMatch(/mm-tone-\d/);
  });

  it('keeps two small categories side by side (no lone wide tile)', () => {
    render(
      <CategoryGrid
        categories={[node('a', 'demo-mevalar', 'Mevalar'), node('b', 'demo-non', 'Non')]}
        locale="uz"
        label="Katalog"
      />,
    );
    for (const tile of screen.getAllByTestId('catalog-category')) {
      expect(tile.closest('li')).not.toHaveClass('col-span-2');
    }
  });

  it('puts the category photo in the corner when there is one, the line icon otherwise', () => {
    render(
      <CategoryGrid
        categories={[
          { ...node('a', 'demo-mevalar', 'Mevalar'), image_url: '/categories/mevalar.webp' },
          node('b', 'demo-non', 'Non'),
        ]}
        locale="uz"
        label="Katalog"
      />,
    );
    const [withPhoto, withIcon] = screen.getAllByTestId('catalog-category');
    expect(withPhoto?.querySelector('img')).toHaveAttribute(
      'srcset',
      '/categories/mevalar-400.webp 400w, /categories/mevalar.webp 800w',
    );
    expect(withPhoto).toHaveAccessibleName('Mevalar');
    expect(withIcon?.querySelector('img')).toBeNull();
  });
});
