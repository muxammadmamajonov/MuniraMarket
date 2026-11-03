import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { BottomNav, activeTab, hidesBottomNav } from './bottom-nav';

const nav = vi.hoisted(() => ({ pathname: '/uz' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

const cart = vi.hoisted(() => ({ itemCount: 0 }));
vi.mock('@/lib/cart', () => ({ useOptionalCart: () => cart }));

function renderNav(pathname: string, locale: 'uz' | 'ru' = 'uz') {
  nav.pathname = pathname;
  return render(
    <LocaleProvider locale={locale}>
      <BottomNav />
    </LocaleProvider>,
  );
}

beforeEach(() => {
  cart.itemCount = 0;
});

describe('activeTab / hidesBottomNav', () => {
  it.each([
    ['/uz', 'home'],
    ['/uz/catalog', 'catalog'],
    ['/uz/c/sut-mahsulotlari', 'catalog'],
    ['/ru/p/kefir-1l', 'catalog'],
    ['/uz/search', 'catalog'],
    ['/uz/cart', 'cart'],
    ['/uz/profile', 'profile'],
    ['/uz/orders/123', 'profile'],
    ['/uz/unknown', null],
  ])('%s -> %s', (path, tab) => {
    expect(activeTab(path)).toBe(tab);
  });

  it('steps aside on checkout and the sign-in callback only', () => {
    expect(hidesBottomNav('/uz/checkout')).toBe(true);
    expect(hidesBottomNav('/ru/auth/telegram')).toBe(true);
    expect(hidesBottomNav('/uz/cart')).toBe(false);
    expect(hidesBottomNav('/uz')).toBe(false);
  });
});

describe('BottomNav', () => {
  it('has four real tabs (Uzbek) and marks the current one', () => {
    renderNav('/uz/c/ichimliklar');
    const bar = screen.getByRole('navigation', { name: 'Bo‘limlar' });
    const links = within(bar).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/uz',
      '/uz/catalog',
      '/uz/cart',
      '/uz/profile',
    ]);
    expect(links.map((link) => link.textContent)).toEqual([
      'Bosh sahifa',
      'Katalog',
      'Savat',
      'Profil',
    ]);
    expect(within(bar).getByRole('link', { name: 'Katalog' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(links.filter((link) => link.hasAttribute('aria-current'))).toHaveLength(1);
    // Mobile only: wide screens keep the header navigation.
    expect(bar.className).toContain('md:hidden');
    expect(bar).toHaveAttribute('data-bottom-nav');
  });

  it('is localized (Russian)', () => {
    renderNav('/ru/profile', 'ru');
    const bar = screen.getByRole('navigation', { name: 'Разделы' });
    expect(within(bar).getByRole('link', { name: 'Профиль' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(bar).getByRole('link', { name: 'Каталог' })).toHaveAttribute(
      'href',
      '/ru/catalog',
    );
  });

  it('shows no badge for an empty cart', () => {
    renderNav('/uz');
    expect(screen.queryByTestId('bottom-nav-cart-count')).toBeNull();
    expect(screen.getByTestId('bottom-nav-cart')).toHaveAccessibleName('Savat');
  });

  it('gives the cart badge an accessible count', () => {
    cart.itemCount = 3;
    renderNav('/uz');
    expect(screen.getByTestId('bottom-nav-cart-count')).toHaveTextContent('3');
    expect(screen.getByTestId('bottom-nav-cart')).toHaveAccessibleName('Savat: 3 ta mahsulot');
  });

  it('caps a huge count visually at 99+ but announces the real number', () => {
    cart.itemCount = 12_345;
    renderNav('/ru/cart', 'ru');
    expect(screen.getByTestId('bottom-nav-cart-count')).toHaveTextContent('99+');
    expect(screen.getByTestId('bottom-nav-cart')).toHaveAccessibleName('Корзина: 12345 шт.');
    expect(screen.getByTestId('bottom-nav-cart')).toHaveAttribute('aria-current', 'page');
  });

  it('is not rendered on checkout, so it never competes with the submit bar or MainButton', () => {
    renderNav('/uz/checkout');
    expect(screen.queryByTestId('bottom-nav')).toBeNull();
  });

  it('pads itself by the bottom and side safe-area insets', () => {
    renderNav('/uz');
    const className = screen.getByTestId('bottom-nav').className;
    expect(className).toContain('pb-(--mm-inset-bottom)');
    expect(className).toContain('pl-(--mm-inset-left)');
    expect(className).toContain('pr-(--mm-inset-right)');
  });
});
