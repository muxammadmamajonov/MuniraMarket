import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { SortSelect, sortHref } from './sort-select';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => nav }));

describe('sortHref', () => {
  it('leaves the default sort and keeps the other params', () => {
    expect(sortHref('/uz/search', 'newest', { q: 'olma' })).toBe('/uz/search?q=olma');
    expect(sortHref('/uz/c/x', 'price_asc')).toBe('/uz/c/x?sort=price_asc');
  });
});

describe('SortSelect', () => {
  it('is a custom listbox (no native select) that navigates to the chosen sort', () => {
    const { container } = render(
      <LocaleProvider locale="uz">
        <SortSelect value="newest" basePath="/uz/c/x" params={{ q: 'olma' }} />
      </LocaleProvider>,
    );
    expect(container.querySelector('select')).toBeNull();
    const combobox = screen.getByRole('combobox', { name: /Saralash/ });
    expect(combobox).toHaveTextContent('Yangilari');
    fireEvent.click(combobox);
    fireEvent.click(screen.getByRole('option', { name: 'Avval arzonlari' }));
    expect(nav.push).toHaveBeenCalledExactlyOnceWith('/uz/c/x?q=olma&sort=price_asc');
  });
});
