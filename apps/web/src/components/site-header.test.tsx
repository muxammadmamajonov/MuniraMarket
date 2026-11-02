import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDictionary } from '@/i18n';
import { LocaleProvider } from '@/i18n/context';
import { CartProvider } from '@/lib/cart';
import { makeCart, makeLine, makeProduct } from '@/lib/cart/test-fixtures';
import { TelegramProvider } from '@/lib/telegram';
import { SiteHeader } from './site-header';

vi.mock('next/navigation', () => ({ usePathname: () => '/uz' }));

const session = vi.hoisted(() => ({
  status: 'authenticated' as 'loading' | 'authenticated' | 'anonymous' | 'error',
  user: { id: 'u1', first_name: 'Ali' } as { id: string; first_name: string } | null,
  error: null as unknown,
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  retry: vi.fn(),
  loginWithWidget: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ useSession: () => session }));

function renderHeader(locale: 'uz' | 'ru' = 'uz') {
  return render(
    <LocaleProvider locale={locale}>
      <TelegramProvider>
        <CartProvider>
          <SiteHeader locale={locale} dict={getDictionary(locale)} />
        </CartProvider>
      </TelegramProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  session.status = 'authenticated';
  session.user = { id: 'u1', first_name: 'Ali' };
  session.apiFetch.mockReset();
  session.apiFetch.mockResolvedValue(Response.json(makeCart()));
});

describe('SiteHeader', () => {
  it('has the wordmark linking home, orders, cart and a one-button language switch', () => {
    renderHeader();
    const home = screen.getByRole('link', { name: /MuniraMarket/ });
    expect(home).toHaveAttribute('href', '/uz');
    expect(within(home).getByRole('img', { name: 'MuniraMarket' })).toBeInTheDocument();
    expect(within(home).getByTestId('munira-mark')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Buyurtmalarim' })).toHaveAttribute(
      'href',
      '/uz/orders',
    );
    expect(screen.getByRole('link', { name: 'Savat' })).toHaveAttribute('href', '/uz/cart');
    expect(screen.getByRole('link', { name: 'Русский' })).toHaveTextContent('RU');
    expect(screen.getByRole('button', { name: 'Chiqish' })).toBeInTheDocument();
  });

  it('shows no badge for an empty cart', async () => {
    renderHeader();
    await waitFor(() => expect(session.apiFetch).toHaveBeenCalled());
    expect(screen.queryByTestId('cart-count')).not.toBeInTheDocument();
  });

  it('shows the server count in the badge and in the cart link name', async () => {
    session.apiFetch.mockResolvedValue(
      Response.json(makeCart([makeLine(makeProduct(), 3), makeLine(makeProduct({ id: 'p2' }), 4)])),
    );
    renderHeader();
    expect(await screen.findByTestId('cart-count')).toHaveTextContent('7');
    expect(screen.getByTestId('header-cart')).toHaveAccessibleName('Savat. Mahsulotlar soni: 7');
  });

  it('caps a very large count at 99+', async () => {
    session.apiFetch.mockResolvedValue(
      Response.json(
        makeCart([makeLine(makeProduct(), 99), makeLine(makeProduct({ id: 'p2' }), 50)]),
      ),
    );
    renderHeader();
    expect(await screen.findByTestId('cart-count')).toHaveTextContent('99+');
  });

  it('is localized', () => {
    renderHeader('ru');
    expect(screen.getByRole('link', { name: 'Корзина' })).toHaveAttribute('href', '/ru/cart');
    expect(screen.getByRole('link', { name: 'Мои заказы' })).toHaveAttribute('href', '/ru/orders');
    expect(screen.getByRole('link', { name: 'O‘zbekcha' })).toHaveTextContent('UZ');
  });
});
