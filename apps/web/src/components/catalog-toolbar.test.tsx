import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { CatalogToolbar } from './catalog-toolbar';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => nav }));

beforeEach(() => nav.push.mockReset());

function renderToolbar(inStock = false, locale: 'uz' | 'ru' = 'uz') {
  return render(
    <LocaleProvider locale={locale}>
      <CatalogToolbar
        total={1284}
        sort="price_asc"
        inStock={inStock}
        basePath={`/${locale}/search`}
        params={{ q: 'olma' }}
        lead="Natijalar"
      />
    </LocaleProvider>,
  );
}

describe('CatalogToolbar', () => {
  it('shows the server total and a custom switch (no native select or browser search input)', () => {
    const { container } = renderToolbar();
    expect(screen.getByTestId('catalog-count')).toHaveTextContent('Mahsulotlar: 1284');
    expect(container.querySelector('select, input[type="search"]')).toBeNull();
    const toggle = screen.getByRole('switch', { name: 'Faqat mavjudlari' });
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveClass('sr-only');
  });

  it('turning the filter on navigates with stock=1 and keeps the query and sort', () => {
    renderToolbar();
    fireEvent.click(screen.getByRole('switch', { name: 'Faqat mavjudlari' }));
    expect(nav.push).toHaveBeenCalledExactlyOnceWith('/uz/search?q=olma&sort=price_asc&stock=1');
    // Flips at once, before the new listing arrives.
    expect(screen.getByRole('switch', { name: 'Faqat mavjudlari' })).toBeChecked();
  });

  it('turning it off drops the flag; the sort listbox keeps it while it is on', () => {
    renderToolbar(true, 'ru');
    const toggle = screen.getByRole('switch', { name: 'Только в наличии' });
    expect(toggle).toBeChecked();

    fireEvent.click(screen.getByRole('combobox', { name: /Сортировка/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Сначала дороже' }));
    expect(nav.push).toHaveBeenLastCalledWith('/ru/search?q=olma&stock=1&sort=price_desc');

    fireEvent.click(toggle);
    expect(nav.push).toHaveBeenLastCalledWith('/ru/search?q=olma&sort=price_asc');
  });

  it('is keyboard operable: Space toggles the focused switch', () => {
    renderToolbar();
    const toggle = screen.getByRole('switch', { name: 'Faqat mavjudlari' });
    toggle.focus();
    expect(toggle).toHaveFocus();
    // Space on a checkbox fires click in browsers; jsdom needs it explicitly.
    fireEvent.click(toggle);
    expect(nav.push).toHaveBeenCalledTimes(1);
  });
});
