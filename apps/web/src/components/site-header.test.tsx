import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDictionary } from '@/i18n';
import { LocaleProvider } from '@/i18n/context';
import { CartProvider } from '@/lib/cart';
import { makeCart, makeLine, makeProduct } from '@/lib/cart/test-fixtures';
import { TelegramProvider } from '@/lib/telegram';
import { parentFor } from '@/lib/back-navigation';
import { SiteHeader, type SiteHeaderProps } from './site-header';

const nav = vi.hoisted(() => ({ pathname: '/uz' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

const session = vi.hoisted(() => ({
  status: 'authenticated' as 'loading' | 'authenticated' | 'anonymous' | 'error',
  user: { id: 'u1', first_name: 'Ali' } as { id: string; first_name: string } | null,
  error: null as unknown,
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  retry: vi.fn(),
  startTelegramLogin: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ useSession: () => session }));

function renderHeader(
  locale: 'uz' | 'ru' = 'uz',
  props: Omit<SiteHeaderProps, 'locale' | 'dict'> = {},
) {
  return render(
    <LocaleProvider locale={locale}>
      <TelegramProvider>
        <CartProvider>
          <SiteHeader locale={locale} dict={getDictionary(locale)} {...props} />
        </CartProvider>
      </TelegramProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  nav.pathname = '/uz';
  session.status = 'authenticated';
  session.user = { id: 'u1', first_name: 'Ali' };
  session.apiFetch.mockReset();
  session.apiFetch.mockResolvedValue(Response.json(makeCart()));
});

describe('SiteHeader', () => {
  it('has the wordmark linking home, orders and cart, and no language switch (Profile only)', () => {
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
    expect(screen.queryByRole('link', { name: 'Русский' })).toBeNull();
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

  it('shows the logo on the home page and no title', () => {
    renderHeader();
    expect(screen.getByTestId('header-logo')).toBeInTheDocument();
    expect(screen.queryByTestId('header-title')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByRole('banner')).toHaveAttribute('data-page-header', 'logo');
  });

  it('shows the page title instead of the logo on inner pages, as the page h1', () => {
    renderHeader('uz', { title: 'Katalog' });
    expect(screen.queryByTestId('header-logo')).toBeNull();
    const title = screen.getByRole('heading', { level: 1, name: 'Katalog' });
    expect(title).toHaveAttribute('data-testid', 'header-title');
    // One line, cut with an ellipsis instead of running under Telegram's buttons.
    expect(title).toHaveClass('truncate', 'min-w-0');
    expect(screen.getByRole('banner')).toHaveAttribute('data-page-header', 'title');
    // Wide screens have no tab bar, so a small mark still leads home.
    expect(screen.getByTestId('header-home')).toHaveAttribute('href', '/uz');
    expect(screen.getByTestId('header-home')).toHaveClass('hidden', 'md:inline-flex');
  });

  it('keeps the full title for assistive tech and as a tooltip, however long', () => {
    const long = 'Qaymoqli shokoladli muzqaymoq, vanilli, 500 g, katta oilaviy qadoq';
    renderHeader('uz', { title: long });
    const title = screen.getByRole('heading', { level: 1 });
    expect(title).toHaveTextContent(long);
    expect(title).toHaveAttribute('title', long);
  });

  it('leaves the slot empty while the title is unknown (loading), never flashing the logo', () => {
    renderHeader('uz', { title: null });
    expect(screen.queryByTestId('header-logo')).toBeNull();
    expect(screen.queryByTestId('header-title')).toBeNull();
  });

  it('has no back button or back link of its own', () => {
    renderHeader('ru', { title: 'Каталог' });
    expect(screen.queryByRole('button', { name: /назад/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /назад/i })).toBeNull();
  });

  it("registers the page's parent for Telegram's BackButton while mounted", () => {
    nav.pathname = '/uz/p/olma';
    const { unmount } = renderHeader('uz', { title: 'Olma', parentHref: '/uz/c/fruits' });
    expect(parentFor('/uz/p/olma')).toBe('/uz/c/fruits');
    unmount();
    expect(parentFor('/uz/p/olma')).toBe('/uz/catalog');
  });

  it('is localized', () => {
    renderHeader('ru');
    expect(screen.getByRole('link', { name: 'Корзина' })).toHaveAttribute('href', '/ru/cart');
    expect(screen.getByRole('link', { name: 'Мои заказы' })).toHaveAttribute('href', '/ru/orders');
    expect(screen.queryByRole('link', { name: 'O‘zbekcha' })).toBeNull();
  });
});
