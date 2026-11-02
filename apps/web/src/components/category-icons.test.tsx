import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CategoryIcon, categoryIconFor } from './category-icons';

describe('categoryIconFor', () => {
  it.each([
    ['demo-mevalar-sabzavotlar', 'produce'],
    ['demo-sabzavotlar', 'produce'],
    ['demo-non', 'bread'],
    ['demo-sut', 'dairy'],
    ['demo-gosht', 'meat'],
    ['demo-bakaleya', 'grain'],
    ['demo-yog-ziravor', 'oil'],
    ['demo-ichimliklar', 'drink'],
    ['demo-sharbatlar', 'drink'],
    ['demo-choy-shirinlik', 'tea'],
    ['demo-uy-rozgor', 'household'],
    ['Meat-and-poultry', 'meat'],
    ['bolalar-uchun', 'basket'],
  ] as const)('%s -> %s', (slug, kind) => {
    expect(categoryIconFor(slug)).toBe(kind);
  });
});

describe('CategoryIcon', () => {
  it('is a decorative inline SVG that follows the text colour', () => {
    const { container } = render(<CategoryIcon kind="tea" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('stroke', 'currentColor');
    expect(svg).toHaveAttribute('data-icon', 'tea');
  });
});
