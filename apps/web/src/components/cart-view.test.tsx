import type { Cart, CartLine, ProductSummary } from '@muniramarket/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { TelegramProvider } from '@/lib/telegram';
import { CartView } from './cart-view';

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

beforeEach(() => {
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

  it('shows the checkout-coming-soon note', async () => {
    session.apiFetch.mockResolvedValue(respond(cart()));
    renderCart();
    expect(await screen.findByTestId('checkout-soon')).toHaveTextContent(
      'Buyurtma berish tez orada qo‘shiladi.',
    );
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
