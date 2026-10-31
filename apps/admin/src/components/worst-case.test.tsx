import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeApi, json, renderAdmin, sessionHandler } from '@/test-utils/fake-api';
import { dashboard, page } from '@/test-utils/fixtures';
import { setLocation } from '@/test-utils/navigation';
import {
  LONG_NAME,
  LONG_SKU,
  worstAudit,
  worstCategories,
  worstProducts,
  worstSlots,
  worstUsers,
  worstZone,
} from '@/test-utils/worst-case';
import { AuditView } from './audit/audit-view';
import { CategoriesView } from './catalog/categories-view';
import { ProductsList } from './catalog/products-list';
import { DashboardView } from './dashboard';
import { SlotsView } from './delivery/slots-view';
import { ZonesView } from './delivery/zones-view';
import { UsersView } from './users/users-view';

vi.mock('next/navigation', async () => await import('@/test-utils/navigation'));

beforeEach(() => setLocation('/ru/x'));
afterEach(() => vi.unstubAllGlobals());

const serve = (path: string, body: unknown) => (call: { path: string }) =>
  call.path.startsWith(`/api/v1/admin/${path}`) ? json(body) : undefined;

const noGarbage = () => {
  const text = document.body.textContent ?? '';
  for (const bad of ['undefined', 'NaN', 'null', '[object Object]']) {
    expect(text, bad).not.toContain(bad);
  }
};

describe('worst-case data (break-ui regression)', () => {
  it('products: long names and SKUs stay whole, extreme money is exact, untracked/zero/archived read right', async () => {
    installFakeApi(
      sessionHandler('admin'),
      serve('categories', { items: worstCategories }),
      serve('products', page(worstProducts, { total: 1284, total_pages: 65 })),
    );
    renderAdmin(<ProductsList />);
    const links = await screen.findAllByTestId('product-row-link');
    // The full 130-char name is in the DOM (CSS wraps it; nothing truncates it).
    expect(links[0]).toHaveTextContent(LONG_NAME);
    expect(screen.getByText(LONG_SKU)).toBeInTheDocument();
    expect(screen.getByText(/999\s999\s999\s999/)).toBeInTheDocument();
    expect(screen.getByText(/1\s000\s000\s000\s000/)).toBeInTheDocument();
    expect(screen.getByText('Без учёта')).toBeInTheDocument();
    expect(document.querySelector('[data-state="archived"]')).toHaveTextContent('В архиве');
    expect(screen.getByText('Всего: 1 284')).toBeInTheDocument();
    noGarbage();
  });

  it('users: one-letter, empty and emoji names, a 51-char username and a 12-digit id', async () => {
    installFakeApi(sessionHandler('admin'), serve('users', page(worstUsers)));
    renderAdmin(<UsersView />);
    const rows = await screen.findAllByTestId('user-row');
    expect(rows[0]).toHaveTextContent('aleksandra_wisniewska_kowalczyk_the_third_official');
    expect(rows[0]).toHaveTextContent('123456789012');
    expect(rows[1]).toHaveTextContent('J');
    // No name at all: falls back to the Telegram id, with no orphaned "@" or separator.
    expect(rows[2]).toHaveTextContent('Telegram ID 77');
    expect(rows[2]).not.toHaveTextContent('@');
    expect(rows[3]).toHaveTextContent('🦊 👩🏽‍💻 Priya');
    noGarbage();
  });

  it('zones: all twelve districts, a never-free zone and the 1e12 fee', async () => {
    installFakeApi(sessionHandler('admin'), serve('delivery/zones', { items: [worstZone] }));
    renderAdmin(<ZonesView />);
    const card = await screen.findByTestId('zone-card');
    expect(within(card).getByText(/Янгихаётский$/)).toBeInTheDocument();
    expect(card).toHaveTextContent('Бесплатной доставки нет');
    expect(card).toHaveTextContent('00:00–23:59');
    expect(card.textContent?.match(/ский/g)?.length).toBeGreaterThanOrEqual(11);
    noGarbage();
  });

  it('slots: capacity 10 000 with 9 999 reserved, 0 capacity, and exactly-full', async () => {
    installFakeApi(
      sessionHandler('admin'),
      serve('delivery/zones', { items: [worstZone] }),
      serve('delivery/slots', { items: worstSlots, truncated: false }),
    );
    renderAdmin(<SlotsView />);
    const rows = await screen.findAllByTestId('slot-row');
    expect(rows[0]).toHaveTextContent('Занято: 9 999 из 10 000');
    expect(rows[0]).toHaveTextContent('Свободно: 1');
    expect(rows.some((row) => row.textContent?.includes('Занято: 0 из 0'))).toBe(true);
    expect(rows.filter((row) => row.textContent?.includes('Заполнен'))).toHaveLength(2);
    noGarbage();
  });

  it('categories: a very long name and 1 284 products', async () => {
    installFakeApi(sessionHandler('admin'), serve('categories', { items: worstCategories }));
    renderAdmin(<CategoriesView />);
    const rows = await screen.findAllByTestId('category-row');
    expect(rows[1]).toHaveTextContent('Товаров: 1 284');
    expect(rows[1]).toHaveTextContent('organic-fruits-and-vegetables-sold-by-weight');
    expect(rows[0]).toHaveTextContent('Товаров: 1');
    noGarbage();
  });

  it('audit: long values and a null "from" render as text, never as garbage', async () => {
    installFakeApi(sessionHandler('admin'), serve('audit', page([worstAudit])));
    renderAdmin(<AuditView />);
    const row = await screen.findByTestId('audit-row');
    expect(row).toHaveTextContent(LONG_NAME);
    expect(row).toHaveTextContent('image_url: — →');
    expect(row).toHaveTextContent('is_active: Да → Нет');
    noGarbage();
  });

  it('dashboard: 1 284 orders and a 12-digit turnover', async () => {
    installFakeApi(
      sessionHandler('operator'),
      serve(
        'dashboard',
        dashboard({ orders_today: 1284, gmv_today_uzs: 999_999_999_999, new_orders: 1 }),
      ),
    );
    renderAdmin(<DashboardView />);
    expect(await screen.findByTestId('stat-orders-today')).toHaveTextContent('1 284');
    expect(screen.getByTestId('stat-gmv')).toHaveTextContent(/999\s999\s999\s999/);
    noGarbage();
  });

  it('empty lists show a message, not a blank table', async () => {
    installFakeApi(
      sessionHandler('admin'),
      serve('categories', { items: [] }),
      serve('products', page([])),
    );
    renderAdmin(<ProductsList />);
    expect(await screen.findByText('Товаров пока нет.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
