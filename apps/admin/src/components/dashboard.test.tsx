import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeApi, json, money, renderAdmin, sessionHandler } from '@/test-utils/fake-api';
import { dashboard } from '@/test-utils/fixtures';
import { setLocation } from '@/test-utils/navigation';
import { DashboardView } from './dashboard';

vi.mock('next/navigation', async () => await import('@/test-utils/navigation'));

beforeEach(() => setLocation('/ru'));
afterEach(() => vi.unstubAllGlobals());

describe('DashboardView', () => {
  it('renders exactly the values the server computed, for an operator', async () => {
    const api = installFakeApi(sessionHandler('operator'), (call) =>
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
    installFakeApi(sessionHandler('operator'), () => json(dashboard()));
    renderAdmin(<DashboardView />, 'uz');
    const link = (await screen.findByText('Yangi buyurtmalar')).closest('a');
    expect(link).toHaveAttribute('href', '/uz/orders?status=NEW');
  });
});
