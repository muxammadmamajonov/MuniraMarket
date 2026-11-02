import type { CategoryNode } from '@muniramarket/contracts';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CategoryRail } from './category-rail';

const category = (id: string, slug: string, uz: string, ru: string): CategoryNode => ({
  id,
  slug,
  name_uz: uz,
  name_ru: ru,
  image_url: null,
  sort_order: 0,
  children: [],
});

const categories = [
  category('c1', 'meva', 'Meva', 'Фрукты'),
  category('c2', 'sut-mahsulotlari', 'Sut mahsulotlari', 'Молочные продукты'),
];

describe('CategoryRail', () => {
  it('is a scrolling rail of links with an initial-letter tile and a clamped name', () => {
    render(<CategoryRail categories={categories} locale="uz" label="Kategoriyalar" />);
    const nav = screen.getByRole('navigation', { name: 'Kategoriyalar' });
    const list = within(nav).getByRole('list');
    expect(list).toHaveClass('mm-rail');
    const links = within(list).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/uz/c/meva',
      '/uz/c/sut-mahsulotlari',
    ]);
    expect(links[0]).toHaveTextContent('MMeva');
    expect(links[1]?.querySelector('.line-clamp-2')).toHaveAttribute('title', 'Sut mahsulotlari');
  });

  it('uses the page language and the same tint for the same category every time', () => {
    const { container, unmount } = render(
      <CategoryRail categories={categories} locale="ru" label="Категории" />,
    );
    expect(screen.getByRole('link', { name: /Фрукты/ })).toHaveAttribute('href', '/ru/c/meva');
    const first = container.querySelector('[class*="mm-tone-"]')?.className;
    unmount();
    const again = render(<CategoryRail categories={categories} locale="ru" label="Категории" />);
    expect(again.container.querySelector('[class*="mm-tone-"]')?.className).toBe(first);
  });

  it('renders nothing without categories', () => {
    const { container } = render(<CategoryRail categories={[]} locale="uz" label="x" />);
    expect(container).toBeEmptyDOMElement();
  });
});
