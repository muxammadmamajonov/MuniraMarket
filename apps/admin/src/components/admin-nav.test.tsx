import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NAV_ITEMS, isNavActive, navItemsFor } from '@/lib/nav';
import { setLocation } from '@/test-utils/navigation';
import { installFakeApi, renderAdmin, sessionHandler } from '@/test-utils/fake-api';

vi.mock('next/navigation', async () => await import('@/test-utils/navigation'));

beforeEach(() => setLocation('/ru'));
afterEach(() => vi.unstubAllGlobals());

const sidebar = () => screen.getByRole('navigation', { name: 'Основная навигация' });
const labels = (nav: HTMLElement) =>
  within(nav)
    .getAllByRole('link')
    .map((link) => link.textContent);

describe('role-aware navigation', () => {
  it('shows an operator the dashboard and orders, and nothing else', async () => {
    installFakeApi(sessionHandler('operator'));
    renderAdmin(<p>page</p>);
    await screen.findByText('page');
    expect(labels(sidebar())).toEqual(['Главная', 'Заказы']);
    expect(within(sidebar()).queryByText('Каталог')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Пользователи' })).not.toBeInTheDocument();
    // Phone bottom bar: dashboard + orders + the menu button.
    const quick = screen.getByRole('navigation', { name: 'Быстрая навигация' });
    expect(within(quick).getAllByRole('link')).toHaveLength(2);
    expect(within(quick).getByRole('button', { name: 'Меню' })).toBeInTheDocument();
  });

  it('shows an admin catalog, delivery, users and audit as well', async () => {
    installFakeApi(sessionHandler('admin'));
    renderAdmin(<p>page</p>);
    await screen.findByText('page');
    expect(labels(sidebar())).toEqual([
      'Главная',
      'Заказы',
      'Товары',
      'Категории',
      'Импорт и экспорт',
      'Зоны',
      'Слоты',
      'Пользователи',
      'Журнал аудита',
    ]);
    const hrefs = within(sidebar())
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual([
      '/ru',
      '/ru/orders',
      '/ru/catalog/products',
      '/ru/catalog/categories',
      '/ru/catalog/import',
      '/ru/delivery/zones',
      '/ru/delivery/slots',
      '/ru/users',
      '/ru/audit',
    ]);
    // The phone bar keeps the critical tasks one tap away.
    const quick = screen.getByRole('navigation', { name: 'Быстрая навигация' });
    expect(within(quick).getAllByRole('link')).toHaveLength(3);
  });

  it('marks the current page, including sub-pages, and the dashboard only on its own path', async () => {
    setLocation('/uz/orders/abc');
    installFakeApi(sessionHandler('admin'));
    renderAdmin(<p>page</p>, 'uz');
    await screen.findByText('page');
    const current = within(screen.getByRole('navigation', { name: 'Asosiy navigatsiya' }))
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current.map((link) => link.textContent)).toEqual(['Buyurtmalar']);
  });

  it('opens the menu sheet on a phone with everything the bottom bar leaves out', async () => {
    installFakeApi(sessionHandler('admin'));
    renderAdmin(<p>page</p>);
    await screen.findByText('page');
    screen.getByTestId('menu-button').click();
    const dialog = await screen.findByRole('dialog', { name: 'Меню' });
    expect(within(dialog).getByRole('link', { name: 'Пользователи' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Выйти' })).toBeInTheDocument();
  });
});

describe('nav model', () => {
  it('filters by role and matches active paths', () => {
    expect(navItemsFor(false).map((item) => item.id)).toEqual(['dashboard', 'orders']);
    expect(navItemsFor(true)).toHaveLength(NAV_ITEMS.length);
    const dashboard = NAV_ITEMS[0]!;
    expect(isNavActive(dashboard, 'ru', '/ru')).toBe(true);
    expect(isNavActive(dashboard, 'ru', '/ru/orders')).toBe(false);
    expect(isNavActive(NAV_ITEMS[1]!, 'ru', '/ru/orders/x')).toBe(true);
  });
});
