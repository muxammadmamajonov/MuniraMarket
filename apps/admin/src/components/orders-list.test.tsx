import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORDER_STATUSES } from '@muniramarket/contracts';
import {
  apiError,
  deferred,
  installFakeApi,
  json,
  money,
  orderPage,
  orderSummary,
  renderAdmin,
  sessionHandler,
} from '@/test-utils/fake-api';
import { OrdersList } from './orders-list';

const nav = vi.hoisted(() => ({ search: '' }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => '/ru',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

beforeEach(() => {
  nav.search = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ID_2 = '7c2e9d10-5b6a-4c8e-8f31-2a9d4e6b1f22';

describe('OrdersList', () => {
  it('requests the first page of all orders and renders the columns', async () => {
    const api = installFakeApi(sessionHandler('operator'), () =>
      json(
        orderPage([
          orderSummary(),
          orderSummary({
            id: ID_2,
            number: 'MM-000124',
            status: 'DELIVERED',
            item_count: 1,
            total_uzs: 9000,
            created_at: '2026-12-31T19:30:00Z',
          }),
        ]),
      ),
    );
    renderAdmin(<OrdersList />);

    expect(await screen.findByRole('link', { name: 'MM-000123' })).toHaveAttribute(
      'href',
      '/ru/orders/0b1f4c7e-2d4a-4f3b-9a53-6f0f1b8a7c11',
    );
    expect(api.to('/api/v1/admin/orders')[0]?.path).toBe(
      '/api/v1/admin/orders?page=1&page_size=20',
    );

    const rows = screen.getAllByRole('row').slice(1); // without the header row
    expect(rows).toHaveLength(2);
    const first = within(rows[0] as HTMLElement);
    expect(first.getByText('Новый')).toHaveAttribute('data-status', 'NEW');
    expect(first.getByText('3')).toBeInTheDocument();
    expect(first.getByText(money(125000, 'ru'))).toBeInTheDocument();
    // 09:05Z is 14:05 in Asia/Tashkent.
    expect(first.getByText('31.10.2026 14:05')).toBeInTheDocument();
    const second = within(rows[1] as HTMLElement);
    expect(second.getByText('Доставлен')).toBeInTheDocument();
    expect(second.getByText('01.01.2027 00:30')).toBeInTheDocument();

    for (const header of ['Номер', 'Статус', 'Товаров', 'Сумма', 'Создан']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
    // One page only: no pagination.
    expect(screen.queryByRole('navigation', { name: 'Страницы' })).not.toBeInTheDocument();
  });

  it('renders the uz copy and currency', async () => {
    installFakeApi(sessionHandler('operator'), () => json(orderPage([orderSummary()])));
    renderAdmin(<OrdersList />, 'uz');
    expect(await screen.findByText(money(125000, 'uz'))).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Buyurtmalar' })).toBeInTheDocument();
    expect(screen.getByText('Yangi', { selector: '[data-status]' })).toBeInTheDocument();
  });

  it('offers All plus every status as filter links and marks the active one', async () => {
    nav.search = 'status=PICKING';
    installFakeApi(sessionHandler('operator'), () =>
      json(orderPage([orderSummary({ status: 'PICKING' })])),
    );
    renderAdmin(<OrdersList />);
    const filter = await screen.findByRole('navigation', { name: 'Фильтр по статусу' });
    const links = within(filter).getAllByRole('link');
    expect(links).toHaveLength(ORDER_STATUSES.length + 1);
    expect(links[0]).toHaveTextContent('Все');
    expect(links[0]).toHaveAttribute('href', '/ru/orders');
    expect(within(filter).getByRole('link', { name: 'Подтверждён' })).toHaveAttribute(
      'href',
      '/ru/orders?status=CONFIRMED',
    );
    expect(within(filter).getByRole('link', { name: 'Сборка' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(within(filter).getByRole('link', { name: 'Все' })).not.toHaveAttribute('aria-current');
  });

  it('sends the status filter and page from the URL', async () => {
    nav.search = 'status=CANCELLED&page=3';
    const api = installFakeApi(sessionHandler('operator'), () =>
      json(
        orderPage([orderSummary({ status: 'CANCELLED' })], { page: 3, total: 50, total_pages: 5 }),
      ),
    );
    renderAdmin(<OrdersList />);
    await screen.findByRole('link', { name: 'MM-000123' });
    expect(api.to('/api/v1/admin/orders')[0]?.path).toBe(
      '/api/v1/admin/orders?page=3&page_size=20&status=CANCELLED',
    );
  });

  it('ignores a junk filter and page', async () => {
    nav.search = 'status=HACKED&page=-4';
    const api = installFakeApi(sessionHandler('operator'), () => json(orderPage([orderSummary()])));
    renderAdmin(<OrdersList />);
    await screen.findByRole('link', { name: 'MM-000123' });
    expect(api.to('/api/v1/admin/orders')[0]?.path).toBe(
      '/api/v1/admin/orders?page=1&page_size=20',
    );
  });

  it('paginates with previous/next links that keep the filter', async () => {
    nav.search = 'status=NEW&page=2';
    installFakeApi(sessionHandler('operator'), () =>
      json(orderPage([orderSummary()], { page: 2, total: 45, total_pages: 3 })),
    );
    renderAdmin(<OrdersList />);
    const pager = await screen.findByRole('navigation', { name: 'Страницы' });
    expect(within(pager).getByRole('link', { name: 'Назад' })).toHaveAttribute(
      'href',
      '/ru/orders?status=NEW',
    );
    expect(within(pager).getByRole('link', { name: 'Далее' })).toHaveAttribute(
      'href',
      '/ru/orders?status=NEW&page=3',
    );
    expect(within(pager).getByText('Страница 2 из 3')).toBeInTheDocument();
  });

  it('disables previous on the first page and next on the last', async () => {
    installFakeApi(sessionHandler('operator'), () =>
      json(orderPage([orderSummary()], { page: 1, total: 45, total_pages: 3 })),
    );
    const first = renderAdmin(<OrdersList />);
    const pager = await screen.findByRole('navigation', { name: 'Страницы' });
    expect(within(pager).queryByRole('link', { name: 'Назад' })).not.toBeInTheDocument();
    expect(within(pager).getByText('Назад')).toHaveAttribute('aria-disabled', 'true');
    expect(within(pager).getByRole('link', { name: 'Далее' })).toBeInTheDocument();
    first.unmount();

    nav.search = 'page=3';
    installFakeApi(sessionHandler('operator'), () =>
      json(orderPage([orderSummary()], { page: 3, total: 45, total_pages: 3 })),
    );
    renderAdmin(<OrdersList />);
    const last = await screen.findByRole('navigation', { name: 'Страницы' });
    expect(within(last).queryByRole('link', { name: 'Далее' })).not.toBeInTheDocument();
    expect(within(last).getByRole('link', { name: 'Назад' })).toHaveAttribute(
      'href',
      '/ru/orders?page=2',
    );
  });

  it('shows a loading state while the request is open, then the empty state (all and filtered)', async () => {
    const gate = deferred<Response>();
    installFakeApi(sessionHandler('operator'), () => gate.promise);
    const all = renderAdmin(<OrdersList />);
    expect(await screen.findByRole('status', { name: 'Загрузка заказов…' })).toBeInTheDocument();
    gate.resolve(json(orderPage([])));
    expect(await screen.findByText('Заказов пока нет.')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Загрузка заказов…' })).not.toBeInTheDocument();
    all.unmount();

    nav.search = 'status=NEW';
    installFakeApi(sessionHandler('operator'), () => json(orderPage([])));
    renderAdmin(<OrdersList />);
    expect(await screen.findByText('Заказов с таким статусом нет.')).toBeInTheDocument();
  });

  it('shows an error with retry and recovers', async () => {
    let attempts = 0;
    installFakeApi(sessionHandler('operator'), () => {
      attempts += 1;
      return attempts === 1
        ? apiError(503, 'service_unavailable')
        : json(orderPage([orderSummary()]));
    });
    renderAdmin(<OrdersList />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Произошла ошибка');
    expect(alert).toHaveTextContent('Сервис временно недоступен');
    fireEvent.click(within(alert).getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('link', { name: 'MM-000123' })).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('explains a 403 from the API without offering a retry', async () => {
    installFakeApi(sessionHandler('operator'), () => apiError(403, 'forbidden'));
    renderAdmin(<OrdersList />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('У вас нет доступа к этим данным.');
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument();
  });

  it('never logs to the console (no PII in logs)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    installFakeApi(sessionHandler('operator'), () => json(orderPage([orderSummary()])));
    renderAdmin(<OrdersList />);
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'MM-000123' })).toBeInTheDocument(),
    );
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
