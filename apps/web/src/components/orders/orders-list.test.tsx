import { ORDER_STATUSES } from '@muniramarket/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { apiError, orderSummary, respond, WORST } from '@/lib/checkout/test-fixtures';
import { TelegramProvider } from '@/lib/telegram';
import { OrdersList } from './orders-list';

const session = vi.hoisted(() => ({
  status: 'authenticated' as 'loading' | 'authenticated' | 'anonymous' | 'error',
  user: null,
  error: null as unknown,
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  retry: vi.fn(),
  loginWithWidget: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ useSession: () => session }));

const NB = ' ';

function pageOf(items: ReturnType<typeof orderSummary>[], extra: Record<string, unknown> = {}) {
  return { items, page: 1, page_size: 10, total: items.length, total_pages: 1, ...extra };
}

function renderList(page = 1, locale: 'uz' | 'ru' = 'uz') {
  return render(
    <LocaleProvider locale={locale}>
      <TelegramProvider>
        <OrdersList page={page} />
      </TelegramProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  session.status = 'authenticated';
  session.apiFetch.mockReset();
  session.retry.mockReset();
});

describe('OrdersList', () => {
  it('lists orders with number, localized status, Tashkent date, item count and total', async () => {
    session.apiFetch.mockResolvedValue(
      respond(
        pageOf([
          orderSummary(),
          orderSummary({
            id: 'b7b0a4f2-0000-4000-8000-000000000002',
            number: 'MM-000122',
            status: 'DELIVERED',
            item_count: 1,
            total_uzs: 1250000,
            created_at: '2026-03-01T00:00:00Z',
          }),
        ]),
      ),
    );
    renderList();

    const cards = await screen.findAllByTestId('order-card');
    expect(cards).toHaveLength(2);
    expect(session.apiFetch).toHaveBeenCalledWith('/orders?page=1&page_size=10', { method: 'GET' });

    expect(within(cards[0] as HTMLElement).getByText('Buyurtma № MM-000123')).toBeInTheDocument();
    expect(within(cards[0] as HTMLElement).getByText('Yangi')).toBeInTheDocument();
    expect(cards[0]).toHaveTextContent('01.11.2026 02:30');
    expect(cards[0]).toHaveTextContent('4 ta mahsulot');
    expect(within(cards[0] as HTMLElement).getByTestId('order-total').textContent).toBe(
      `75${NB}000${NB}so‘m`,
    );
    expect(cards[0]).toHaveAttribute('href', '/uz/orders/3f2a9c1e-5b7d-4e8a-9c3b-1a2b3c4d5e6f');
    expect(within(cards[1] as HTMLElement).getByText('Yetkazildi')).toBeInTheDocument();
    expect(cards[1]).toHaveTextContent('01.03.2026 05:00');
    expect(within(cards[1] as HTMLElement).getByTestId('order-total').textContent).toBe(
      `1${NB}250${NB}000${NB}so‘m`,
    );
  });

  it('localizes every status in both languages (the badge text carries the meaning)', async () => {
    for (const locale of ['uz', 'ru'] as const) {
      session.apiFetch.mockResolvedValue(
        respond(
          pageOf(
            ORDER_STATUSES.map((status, index) =>
              orderSummary({ id: `id-${String(index)}`, number: `N${String(index)}`, status }),
            ),
          ),
        ),
      );
      const { unmount } = renderList(1, locale);
      const cards = await screen.findAllByTestId('order-card');
      const badges = cards.map((card) => card.querySelector('[data-status]'));
      expect(badges.map((badge) => badge?.getAttribute('data-status'))).toEqual([
        ...ORDER_STATUSES,
      ]);
      const texts = badges.map((badge) => badge?.textContent ?? '');
      expect(new Set(texts).size).toBe(ORDER_STATUSES.length);
      for (const text of texts) expect(text).not.toBe('');
      if (locale === 'ru') expect(texts).toContain('Готов к доставке');
      unmount();
    }
  });

  it('uses Russian plurals for the item count', async () => {
    session.apiFetch.mockResolvedValue(
      respond(
        pageOf([
          orderSummary({ id: 'a', item_count: 1 }),
          orderSummary({ id: 'b', item_count: 2 }),
          orderSummary({ id: 'c', item_count: 5 }),
        ]),
      ),
    );
    renderList(1, 'ru');
    const cards = await screen.findAllByTestId('order-card');
    expect(cards[0]).toHaveTextContent('1 товар');
    expect(cards[1]).toHaveTextContent('2 товара');
    expect(cards[2]).toHaveTextContent('5 товаров');
    expect(cards[0]).toHaveTextContent('Заказ № MM-000123');
  });

  it('shows an empty state with a way to the catalog when there are no orders (0)', async () => {
    session.apiFetch.mockResolvedValue(respond(pageOf([], { total: 0, total_pages: 0 })));
    renderList();
    expect(await screen.findByText('Hali buyurtmalar yo‘q')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Katalogga o‘tish' })).toHaveAttribute('href', '/uz');
    expect(screen.queryByTestId('order-card')).toBeNull();
  });

  it('paginates with real links and asks the API for the requested page', async () => {
    session.apiFetch.mockResolvedValue(
      respond(pageOf([orderSummary()], { page: 2, total: 25, total_pages: 3 })),
    );
    renderList(2);
    await screen.findByTestId('order-card');
    expect(session.apiFetch).toHaveBeenCalledWith('/orders?page=2&page_size=10', { method: 'GET' });
    const nav = screen.getByRole('navigation', { name: 'Sahifalar' });
    expect(within(nav).getByRole('link', { name: 'Oldingi' })).toHaveAttribute(
      'href',
      '/uz/orders',
    );
    expect(within(nav).getByRole('link', { name: 'Keyingi' })).toHaveAttribute(
      'href',
      '/uz/orders?page=3',
    );
  });

  it('offers the first page when the requested page is past the end', async () => {
    session.apiFetch.mockResolvedValue(respond(pageOf([], { page: 9, total: 3, total_pages: 1 })));
    renderList(9);
    expect(await screen.findByText('9-sahifada buyurtmalar yo‘q.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Birinchi sahifaga' })).toHaveAttribute(
      'href',
      '/uz/orders',
    );
  });

  it('shows a skeleton while loading, the sign-in prompt when anonymous, and retries on failure', async () => {
    session.apiFetch.mockReturnValue(new Promise(() => undefined));
    const first = renderList();
    expect(screen.getByRole('status', { name: 'Buyurtmalar yuklanmoqda…' })).toBeInTheDocument();
    first.unmount();

    session.status = 'anonymous';
    session.apiFetch.mockReset();
    session.apiFetch.mockResolvedValue(
      respond({ telegram_login_widget: { enabled: false, bot_username: null } }),
    );
    const second = renderList();
    expect(screen.getByRole('status')).toHaveTextContent('Telegram orqali oching');
    expect(session.apiFetch).not.toHaveBeenCalledWith(
      '/orders?page=1&page_size=10',
      expect.anything(),
    );
    second.unmount();

    session.status = 'authenticated';
    session.apiFetch.mockReset();
    session.apiFetch.mockResolvedValueOnce(apiError('internal_error', 500));
    renderList();
    expect(await screen.findByRole('alert')).toHaveTextContent('Buyurtmalarni yuklab bo‘lmadi.');
    session.apiFetch.mockResolvedValueOnce(respond(pageOf([orderSummary()])));
    fireEvent.click(screen.getByRole('button', { name: 'Qayta urinish' }));
    expect(await screen.findByTestId('order-card')).toBeInTheDocument();
  });

  it('recovers the session when the API says it ended', async () => {
    session.apiFetch.mockResolvedValue(apiError('session_required', 401));
    renderList();
    await screen.findByRole('alert');
    expect(session.retry).toHaveBeenCalled();
  });

  it('keeps worst-case rows intact: long number wraps, badge and total never shrink or truncate', async () => {
    session.apiFetch.mockResolvedValue(
      respond(
        pageOf([
          orderSummary({
            number: `MM-${'9'.repeat(40)}`,
            status: 'READY_FOR_DELIVERY',
            total_uzs: WORST.hugeTotal,
            item_count: 4950,
          }),
        ]),
      ),
    );
    renderList(1, 'ru');
    const card = await screen.findByTestId('order-card');
    const number = card.querySelector('[data-user-text]');
    expect(number?.textContent).toContain('9'.repeat(40));
    expect(number?.className).toContain('min-w-0');
    const badge = card.querySelector('[data-status]');
    expect(badge?.className).toContain('shrink-0');
    expect(badge?.className).toContain('whitespace-nowrap');
    const total = within(card).getByTestId('order-total');
    expect(total.textContent).toBe('9 999 999 000 сум');
    expect(total.className).toContain('shrink-0');
    expect(card.innerHTML).not.toContain('truncate');
    expect(card).toHaveTextContent('4950 товаров');
    // Press feedback is :active-based (touch has no hover) and the card is a 44px+ target.
    expect(card.className).toContain('active:scale-[0.97]');
    expect(card.className).toContain('min-h-11');
  });

  it('re-fetches when the page changes', async () => {
    session.apiFetch.mockResolvedValue(respond(pageOf([orderSummary()])));
    const { rerender } = renderList(1);
    await screen.findByTestId('order-card');
    rerender(
      <LocaleProvider locale="uz">
        <TelegramProvider>
          <OrdersList page={2} />
        </TelegramProvider>
      </LocaleProvider>,
    );
    await waitFor(() =>
      expect(session.apiFetch).toHaveBeenCalledWith('/orders?page=2&page_size=10', {
        method: 'GET',
      }),
    );
  });
});
