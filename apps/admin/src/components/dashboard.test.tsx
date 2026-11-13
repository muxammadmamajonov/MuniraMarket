import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installFakeApi,
  json,
  money,
  orderPage,
  orderSummary,
  renderAdmin,
  sessionHandler,
  type FakeHandler,
} from '@/test-utils/fake-api';
import { dashboard } from '@/test-utils/fixtures';
import { setLocation } from '@/test-utils/navigation';
import { DashboardView } from './dashboard';

vi.mock('next/navigation', async () => await import('@/test-utils/navigation'));

beforeEach(() => setLocation('/ru'));
afterEach(() => vi.unstubAllGlobals());

/** The latest-orders list under the numbers. */
function recentOrders(items = [orderSummary()]): FakeHandler {
  return (call) =>
    call.path.startsWith('/api/v1/admin/orders?') ? json(orderPage(items)) : undefined;
}

describe('DashboardView', () => {
  it('renders exactly the values the server computed, for an operator', async () => {
    const api = installFakeApi(sessionHandler('operator'), recentOrders(), (call) =>
      call.path === '/api/v1/admin/dashboard'
        ? json(
            dashboard({
              orders_today: 5,
              new_orders: 2,
              gmv_today_uzs: 1_000_000,
              // Deliberately not gmv / orders: the UI must show the server's number, not compute.
              average_order_value_uzs: 123_457,
              cancelled_today: 1,
            }),
          )
        : undefined,
    );
    renderAdmin(<DashboardView />);

    expect(await screen.findByTestId('stat-orders-today')).toHaveTextContent('5');
    expect(screen.getByTestId('stat-new-orders')).toHaveTextContent('2');
    expect(screen.getByTestId('stat-cancelled')).toHaveTextContent('1');
    expect(within(screen.getByTestId('stat-gmv')).getByText(money(1_000_000, 'ru'))).toBeVisible();
    expect(screen.getByTestId('stat-aov')).toHaveTextContent(/123\s457/);
    expect(screen.getByText('На 31.10.2026, время Ташкента')).toBeInTheDocument();
    expect(api.to('/api/v1/admin/dashboard')).toHaveLength(1);
  });

  it('links the NEW card to the orders list filtered by NEW', async () => {
    installFakeApi(sessionHandler('operator'), recentOrders(), (call) =>
      call.path === '/api/v1/admin/dashboard' ? json(dashboard()) : undefined,
    );
    renderAdmin(<DashboardView />, 'uz');
    const link = (await screen.findByText('Yangi buyurtmalar')).closest('a');
    expect(link).toHaveAttribute('href', '/uz/orders?status=NEW');
  });

  it('lists the latest orders, newest first, each linking to its order', async () => {
    const api = installFakeApi(
      sessionHandler('operator'),
      recentOrders([
        orderSummary({ number: 'MM-000124', status: 'NEW' }),
        orderSummary({
          id: '9c1f4c7e-2d4a-4f3b-9a53-6f0f1b8a7c12',
          number: 'MM-000123',
          status: 'DELIVERED',
        }),
      ]),
      (call) => (call.path === '/api/v1/admin/dashboard' ? json(dashboard()) : undefined),
    );
    renderAdmin(<DashboardView />, 'uz');
    const list = await screen.findByTestId('recent-orders');
    const links = within(list).getAllByRole('link');
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveTextContent('MM-000124');
    expect(links[1]).toHaveAttribute('href', '/uz/orders/9c1f4c7e-2d4a-4f3b-9a53-6f0f1b8a7c12');
    expect(screen.getByRole('link', { name: /Barchasi/ })).toHaveAttribute('href', '/uz/orders');
    expect(api.to('/api/v1/admin/orders?page=1&page_size=6')).toHaveLength(1);
  });
});
