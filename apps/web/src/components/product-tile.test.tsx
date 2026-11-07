import type { Cart } from '@muniramarket/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { CartProvider } from '@/lib/cart';
import { makeCart, makeLine, makeProduct } from '@/lib/cart/test-fixtures';
import { TelegramProvider } from '@/lib/telegram';
import { ProductTile } from './product-tile';

const session = vi.hoisted(() => ({
  status: 'authenticated' as 'loading' | 'authenticated' | 'anonymous' | 'error',
  user: { id: 'u1' },
  error: null as unknown,
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  retry: vi.fn(),
  startTelegramLogin: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ useSession: () => session }));

let serverCart: Cart;

function renderTile(overrides = {}, locale: 'uz' | 'ru' = 'uz') {
  return render(
    <LocaleProvider locale={locale}>
      <TelegramProvider>
        <CartProvider>
          <ProductTile product={makeProduct(overrides)} />
        </CartProvider>
      </TelegramProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  session.status = 'authenticated';
  session.apiFetch.mockReset();
  serverCart = makeCart();
  session.apiFetch.mockImplementation(async (path, init) => {
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as { quantity?: number }) : {};
    if (init?.method === 'POST' || init?.method === 'PUT') {
      serverCart = makeCart([makeLine(makeProduct(), body.quantity ?? 1)]);
    } else if (init?.method === 'DELETE') {
      serverCart = makeCart();
    }
    return Response.json(serverCart);
  });
});

describe('ProductTile', () => {
  it('shows the name (clamped; the product page has it in full), the price with its unit and a link to the product', () => {
    renderTile({ name_uz: 'Juda uzun nomli qizil olma, Samarqand navi, 1 kg qadoq' });
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/uz/p/demo-olma');
    expect(link).not.toHaveAttribute('title');
    expect(within(link).getByText(/^Juda uzun/)).toHaveClass('line-clamp-2');
    expect(within(link).getByText(/12\s500/)).toBeInTheDocument();
    expect(within(link).getByText('/ kg')).toBeInTheDocument();
    expect(within(link).queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders the same square tinted monogram placeholder for a product without a photo', () => {
    renderTile({ name_uz: 'Sabzi' });
    const monogram = screen.getByTestId('monogram');
    expect(monogram).toHaveTextContent('S');
    expect(monogram.className).toMatch(/mm-tone-\d/);
    expect(screen.getByTestId('image-placeholder')).toHaveAccessibleName('Sabzi');
    expect(screen.getByTestId('image-placeholder').parentElement).toHaveClass('aspect-square');
  });

  it('uses the Russian name in the Russian locale', () => {
    renderTile({}, 'ru');
    expect(screen.getByRole('link')).toHaveAttribute('href', '/ru/p/demo-olma');
    expect(screen.getByRole('link')).toHaveTextContent('Яблоко');
    expect(screen.getByRole('button', { name: 'В корзину: Яблоко' })).toHaveTextContent(
      'В корзину',
    );
  });

  it('strikes the old price through only when there is one', () => {
    const { container, unmount } = renderTile({ old_price_uzs: 15000 });
    expect(container.querySelector('del')).toHaveTextContent(/15\s000/);
    unmount();
    const second = renderTile({ old_price_uzs: null });
    expect(second.container.querySelector('del')).toBeNull();
  });

  it('shows a low-stock hint for a nearly sold-out product', () => {
    renderTile({ stock_quantity: 3 });
    expect(screen.getByText('Faqat 3 ta qoldi')).toBeInTheDocument();
  });

  it('shows an out-of-stock product with a disabled button and no way to add it', () => {
    renderTile({ in_stock: false, stock_quantity: 0 });
    const button = screen.getByRole('button', { name: 'Tugagan: Olma' });
    expect(button).toBeDisabled();
    expect(screen.getByTestId('product-tile')).toHaveAttribute('data-stock', 'out');
    expect(screen.queryByRole('button', { name: /Savatga qo‘shish/ })).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(session.apiFetch).not.toHaveBeenCalledWith(
      '/cart/items',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('turns "Savatga" into a stepper after adding, and steps the quantity', async () => {
    renderTile();
    fireEvent.click(screen.getByRole('button', { name: 'Savatga qo‘shish: Olma' }));

    const group = await screen.findByRole('group', { name: 'Miqdor: Olma' });
    expect(within(group).getByRole('status')).toHaveTextContent('1');
    const post = session.apiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe('/cart/items');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ product_id: 'p1', quantity: 1 });

    fireEvent.click(within(group).getByRole('button', { name: 'Ko‘paytirish: Olma' }));
    await waitFor(() => expect(within(group).getByRole('status')).toHaveTextContent('2'));
    await waitFor(() => {
      const put = session.apiFetch.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(put?.[0]).toBe('/cart/items/p1');
    });
  });

  it('starts as a stepper when the product is already in the cart, and removes it going below 1', async () => {
    serverCart = makeCart([makeLine(makeProduct(), 1)]);
    renderTile();
    const group = await screen.findByRole('group', { name: 'Miqdor: Olma' });
    // At 1 the minus button is honest about what it does.
    fireEvent.click(within(group).getByRole('button', { name: 'O‘chirish: Olma' }));
    expect(
      await screen.findByRole('button', { name: 'Savatga qo‘shish: Olma' }),
    ).toBeInTheDocument();
    expect(
      session.apiFetch.mock.calls.some(
        ([path, init]) => path === '/cart/items/p1' && init?.method === 'DELETE',
      ),
    ).toBe(true);
  });

  it('does not offer more than the tracked stock', async () => {
    serverCart = makeCart([makeLine(makeProduct({ stock_quantity: 4 }), 4)]);
    renderTile({ stock_quantity: 4 });
    const group = await screen.findByRole('group', { name: 'Miqdor: Olma' });
    expect(within(group).getByRole('button', { name: 'Ko‘paytirish: Olma' })).toBeDisabled();
    expect(within(group).getByRole('button', { name: 'Kamaytirish: Olma' })).toBeEnabled();
  });

  it('keeps the cart control disabled until a session exists', () => {
    session.status = 'anonymous';
    renderTile();
    expect(screen.getByRole('button', { name: 'Savatga qo‘shish: Olma' })).toBeDisabled();
  });

  it('says why a change failed, on the card', async () => {
    session.apiFetch.mockImplementation(async (path, init) =>
      init?.method === 'POST'
        ? Response.json(
            { error: { code: 'insufficient_stock', message: 'x', available_quantity: 2 } },
            { status: 409 },
          )
        : Response.json(makeCart()),
    );
    renderTile();
    fireEvent.click(screen.getByRole('button', { name: 'Savatga qo‘shish: Olma' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Omborda yetarli emas. Mavjud: 2.');
    expect(screen.getByRole('button', { name: 'Savatga qo‘shish: Olma' })).toBeEnabled();
  });
});
