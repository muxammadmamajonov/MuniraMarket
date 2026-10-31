import type { Cart, CartLine, ProductSummary } from '@muniramarket/contracts';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { TelegramProvider } from '@/lib/telegram';
import { installWebApp, makeWebApp, uninstallWebApp } from '@/lib/telegram/test-helpers';
import { CartView } from './cart-view';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push }) }));

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

function product(overrides: Partial<ProductSummary> = {}): ProductSummary {
  return {
    id: 'p1',
    slug: 'demo-apple',
    sku: 'DEMO-0001',
    name_uz: 'Demo olma',
    name_ru: 'Демо яблоко',
    unit: 'kg',
    price_uzs: 12000,
    old_price_uzs: null,
    stock_quantity: null,
    in_stock: true,
    image_url: null,
    category_id: 'c1',
    ...overrides,
  };
}

function line(overrides: Partial<CartLine> & { product?: ProductSummary } = {}): CartLine {
  return {
    product: product(),
    quantity: 2,
    line_total_uzs: 24000,
    issue: null,
    ...overrides,
  };
}

function cart(overrides: Partial<Cart> = {}): Cart {
  return {
    items: [line()],
    item_count: 2,
    subtotal_uzs: 24000,
    total_uzs: 24000,
    has_issues: false,
    ...overrides,
  };
}

function respond(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function renderCart(locale: 'uz' | 'ru' = 'uz') {
  return render(
    <LocaleProvider locale={locale}>
      <TelegramProvider>
        <CartView />
      </TelegramProvider>
    </LocaleProvider>,
  );
}

afterEach(() => {
  uninstallWebApp();
});

beforeEach(() => {
  nav.push.mockReset();
  session.status = 'authenticated';
  session.error = null;
  session.apiFetch.mockReset();
  session.retry.mockReset();
});

describe('CartView', () => {
  it('renders lines and shows the server totals without recomputing them', async () => {
    // Deliberately inconsistent with the lines: the page must show what the server says.
    session.apiFetch.mockResolvedValue(
      respond(cart({ subtotal_uzs: 777000, total_uzs: 888000, item_count: 9 })),
    );
    renderCart();

    expect(await screen.findByText('Demo olma')).toBeInTheDocument();
    expect(screen.getByTestId('cart-subtotal').textContent).toBe('777 000 so‘m');
    expect(screen.getByTestId('cart-total').textContent).toBe('888 000 so‘m');
    expect(screen.getByText('Mahsulotlar soni: 9')).toBeInTheDocument();
    expect(screen.getByTestId('line-total').textContent).toBe('24 000 so‘m');
    expect(session.apiFetch).toHaveBeenCalledWith('/cart', { method: 'GET' });
  });

  it('offers checkout as a primary link to the checkout page', async () => {
    session.apiFetch.mockResolvedValue(respond(cart()));
    renderCart();
    const link = await screen.findByTestId('checkout-link');
    expect(link).toHaveAttribute('href', '/uz/checkout');
    expect(link).toHaveTextContent('Rasmiylashtirish');
    expect(screen.queryByText(/tez orada/)).toBeNull();
  });

  it('disables checkout while a line has an issue (no link to follow)', async () => {
    session.apiFetch.mockResolvedValue(
      respond(
        cart({
          items: [line({ issue: 'product_inactive' })],
          has_issues: true,
        }),
      ),
    );
    renderCart();
    const control = await screen.findByTestId('checkout-link');
    expect(control).toBeDisabled();
    expect(control.tagName).toBe('BUTTON');
    expect(control).not.toHaveAttribute('href');
  });

  it('localizes the checkout link (ru)', async () => {
    session.apiFetch.mockResolvedValue(respond(cart()));
    renderCart('ru');
    expect(await screen.findByTestId('checkout-link')).toHaveAttribute('href', '/ru/checkout');
    expect(screen.getByTestId('checkout-link')).toHaveTextContent('Оформить заказ');
  });

  it('is localized (ru)', async () => {
    session.apiFetch.mockResolvedValue(respond(cart()));
    renderCart('ru');
    expect(await screen.findByText('Демо яблоко')).toBeInTheDocument();
    expect(screen.getByText('Итого')).toBeInTheDocument();
    expect(screen.getByTestId('cart-total').textContent).toContain('сум');
  });

  it('renders per-line issues, hides their totals and explains the exclusion', async () => {
    session.apiFetch.mockResolvedValue(
      respond(
        cart({
          items: [
            line(),
            line({
              product: product({
                id: 'p2',
                slug: 'demo-banana',
                name_uz: 'Demo banan',
                stock_quantity: 3,
              }),
              quantity: 5,
              line_total_uzs: 90000,
              issue: 'insufficient_stock',
            }),
            line({
              product: product({
                id: 'p3',
                slug: 'demo-pear',
                name_uz: 'Demo nok',
                in_stock: false,
              }),
              quantity: 1,
              line_total_uzs: 12000,
              issue: 'product_inactive',
            }),
          ],
          has_issues: true,
        }),
      ),
    );
    renderCart();
    await screen.findByText('Demo banan');

    const lines = screen.getAllByTestId('cart-line');
    expect(lines).toHaveLength(3);
    expect(lines[0]).not.toHaveAttribute('data-issue');
    expect(lines[1]).toHaveAttribute('data-issue', 'insufficient_stock');
    expect(within(lines[1] as HTMLElement).getByRole('alert')).toHaveTextContent(
      'Omborda yetarli emas. Mavjud: 3.',
    );
    expect(within(lines[1] as HTMLElement).queryByTestId('line-total')).toBeNull();
    expect(lines[2]).toHaveAttribute('data-issue', 'product_inactive');
    expect(within(lines[2] as HTMLElement).getByRole('alert')).toHaveTextContent(
      'endi sotuvda yo‘q',
    );
    // Only the valid line shows a line total.
    expect(screen.getAllByTestId('line-total')).toHaveLength(1);
    expect(screen.getByText('Muammoli mahsulotlar jami summaga kiritilmagan.')).toBeInTheDocument();
  });

  it('shows the empty state with a way back to the catalog', async () => {
    session.apiFetch.mockResolvedValue(
      respond(cart({ items: [], item_count: 0, subtotal_uzs: 0, total_uzs: 0 })),
    );
    renderCart();
    expect(await screen.findByText('Savatingiz bo‘sh')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Xaridni davom ettirish' })).toHaveAttribute(
      'href',
      '/uz',
    );
    expect(screen.queryByTestId('cart-total')).toBeNull();
  });

  it('shows a skeleton while loading', () => {
    session.apiFetch.mockReturnValue(new Promise(() => undefined));
    renderCart();
    expect(screen.getByRole('status', { name: 'Savat yuklanmoqda…' })).toBeInTheDocument();
  });

  it('offers a retry when loading fails', async () => {
    session.apiFetch.mockResolvedValueOnce(
      respond({ error: { code: 'internal_error', message: 'x' } }, 500),
    );
    renderCart();
    expect(await screen.findByRole('alert')).toHaveTextContent('Savatni yuklab bo‘lmadi.');

    session.apiFetch.mockResolvedValueOnce(respond(cart()));
    fireEvent.click(screen.getByRole('button', { name: 'Qayta urinish' }));
    expect(await screen.findByText('Demo olma')).toBeInTheDocument();
  });

  it('updates a quantity with PUT and shows the returned cart', async () => {
    session.apiFetch.mockResolvedValueOnce(respond(cart()));
    renderCart();
    await screen.findByText('Demo olma');

    session.apiFetch.mockResolvedValueOnce(
      respond(
        cart({
          items: [line({ quantity: 3, line_total_uzs: 36000 })],
          total_uzs: 36000,
          subtotal_uzs: 36000,
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ko‘paytirish' }));

    await waitFor(() => expect(screen.getByTestId('cart-total').textContent).toContain('36'));
    const call = session.apiFetch.mock.calls[1];
    expect(call?.[0]).toBe('/cart/items/p1');
    expect(call?.[1]?.method).toBe('PUT');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ quantity: 3 });
  });

  it('removes a line with DELETE', async () => {
    session.apiFetch.mockResolvedValueOnce(respond(cart()));
    renderCart();
    await screen.findByText('Demo olma');

    session.apiFetch.mockResolvedValueOnce(
      respond(cart({ items: [], item_count: 0, subtotal_uzs: 0, total_uzs: 0 })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'O‘chirish: Demo olma' }));
    expect(await screen.findByText('Savatingiz bo‘sh')).toBeInTheDocument();
    expect(session.apiFetch.mock.calls[1]?.[1]?.method).toBe('DELETE');
  });

  it('reports insufficient stock on update with the available quantity', async () => {
    session.apiFetch.mockResolvedValueOnce(respond(cart()));
    renderCart();
    await screen.findByText('Demo olma');

    session.apiFetch.mockResolvedValueOnce(
      respond({ error: { code: 'insufficient_stock', message: 'x', available_quantity: 2 } }, 409),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ko‘paytirish' }));
    expect(await screen.findByText('Omborda yetarli emas. Mavjud: 2.')).toBeInTheDocument();
    // The previous cart stays on screen.
    expect(screen.getByText('Demo olma')).toBeInTheDocument();
  });

  describe('when the API says to slow down (429)', () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());

    it('locks the lines for Retry-After, says why, then unlocks and clears the note', async () => {
      session.apiFetch.mockResolvedValueOnce(respond(cart()));
      renderCart();
      await screen.findByText('Demo olma');

      session.apiFetch.mockResolvedValueOnce(
        Response.json(
          { error: { code: 'rate_limited', message: 'x' } },
          { status: 429, headers: { 'Retry-After': '2' } },
        ),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Ko‘paytirish' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Juda ko‘p urinish. Birozdan keyin qayta urinib ko‘ring.',
      );
      const more = screen.getByRole('button', { name: 'Ko‘paytirish' });
      const less = screen.getByRole('button', { name: 'Kamaytirish' });
      expect(more).toBeDisabled();
      expect(less).toBeDisabled();
      expect(screen.getByRole('button', { name: 'O‘chirish: Demo olma' })).toBeDisabled();
      expect(session.apiFetch).toHaveBeenCalledTimes(2);
      // The cart on screen is the one from before.
      expect(screen.getByText('Demo olma')).toBeInTheDocument();

      for (let second = 0; second < 15 && (more as HTMLButtonElement).disabled; second += 1) {
        await act(async () => {
          vi.advanceTimersByTime(1000);
        });
      }
      expect(more).toBeEnabled();
      expect(screen.queryByText(/Juda ko‘p urinish/)).toBeNull();
    });
  });

  it('shows the sign-in prompt instead of the cart when anonymous', () => {
    session.status = 'anonymous';
    session.apiFetch.mockResolvedValue(
      respond({ telegram_login_widget: { enabled: false, bot_username: null } }),
    );
    renderCart();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Savatdan foydalanish uchun saytni Telegram orqali oching.',
    );
    expect(session.apiFetch).not.toHaveBeenCalledWith('/cart', expect.anything());
  });

  it('asks the session layer to recover when the API says the session ended', async () => {
    session.apiFetch.mockResolvedValue(
      respond({ error: { code: 'session_required', message: 'x' } }, 401),
    );
    renderCart();
    await screen.findByRole('alert');
    expect(session.retry).toHaveBeenCalled();
  });
});

describe('CartView in the Telegram Mini App', () => {
  it('claims the MainButton with the server total and opens the checkout on click', async () => {
    const webApp = makeWebApp();
    installWebApp(webApp);
    session.apiFetch.mockResolvedValue(respond(cart({ total_uzs: 24000 })));
    renderCart();
    await screen.findByText('Demo olma');

    await waitFor(() => expect(webApp.MainButton.show).toHaveBeenCalled());
    expect(webApp.MainButton.setText).toHaveBeenLastCalledWith(
      'Rasmiylashtirish — 24\u00A0000\u00A0so‘m',
    );
    vi.mocked(webApp.MainButton.onClick).mock.calls[0]?.[0]();
    expect(nav.push).toHaveBeenCalledWith('/uz/checkout');
  });

  it('keeps the MainButton hidden for an empty cart and for a cart with issues', async () => {
    const webApp = makeWebApp();
    installWebApp(webApp);
    session.apiFetch.mockResolvedValueOnce(
      respond(cart({ items: [], item_count: 0, subtotal_uzs: 0, total_uzs: 0 })),
    );
    const { unmount } = renderCart();
    await screen.findByText('Savatingiz bo‘sh');
    expect(webApp.MainButton.show).not.toHaveBeenCalled();
    unmount();

    session.apiFetch.mockResolvedValueOnce(
      respond(cart({ items: [line({ issue: 'product_inactive' })], has_issues: true })),
    );
    renderCart();
    await screen.findByTestId('checkout-link');
    expect(webApp.MainButton.show).not.toHaveBeenCalled();
  });

  it('releases the MainButton when leaving the cart', async () => {
    const webApp = makeWebApp();
    installWebApp(webApp);
    session.apiFetch.mockResolvedValue(respond(cart()));
    const { unmount } = renderCart();
    await waitFor(() => expect(webApp.MainButton.show).toHaveBeenCalled());
    unmount();
    expect(webApp.MainButton.hide).toHaveBeenCalled();
    expect(webApp.MainButton.offClick).toHaveBeenCalled();
  });
});
