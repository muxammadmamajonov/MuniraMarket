import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { CartProvider } from '@/lib/cart';
import { makeCart, makeLine, makeProduct } from '@/lib/cart/test-fixtures';
import { TelegramProvider } from '@/lib/telegram';
import { installWebApp, makeWebApp, uninstallWebApp } from '@/lib/telegram/test-helpers';
import { CartBar } from './cart-bar';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push }) }));

const session = vi.hoisted(() => ({
  status: 'authenticated' as 'loading' | 'authenticated' | 'anonymous' | 'error',
  user: { id: 'u1' },
  error: null as unknown,
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  retry: vi.fn(),
  loginWithWidget: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ useSession: () => session }));

function renderBar() {
  return render(
    <LocaleProvider locale="uz">
      <TelegramProvider>
        <CartProvider>
          <CartBar />
        </CartProvider>
      </TelegramProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  session.apiFetch.mockReset();
  nav.push.mockReset();
});

afterEach(() => {
  uninstallWebApp();
});

describe('CartBar', () => {
  it('renders nothing while the cart is empty', async () => {
    session.apiFetch.mockResolvedValue(Response.json(makeCart()));
    renderBar();
    await Promise.resolve();
    expect(screen.queryByTestId('cart-bar')).not.toBeInTheDocument();
  });

  it('links to the cart with the unit count and the server total once there are items', async () => {
    session.apiFetch.mockResolvedValue(
      Response.json(makeCart([makeLine(makeProduct(), 2), makeLine(makeProduct({ id: 'p2' }), 1)])),
    );
    renderBar();
    const link = await screen.findByRole('link', { name: /Savatni ochish/ });
    expect(link).toHaveAttribute('href', '/uz/cart');
    expect(screen.getByTestId('cart-bar-count')).toHaveTextContent('3');
    expect(screen.getByTestId('cart-bar-total')).toHaveTextContent(/37\s500/);
  });

  it('inside Telegram the native MainButton replaces the bar', async () => {
    const webApp = makeWebApp();
    installWebApp(webApp);
    session.apiFetch.mockResolvedValue(Response.json(makeCart([makeLine(makeProduct(), 1)])));
    renderBar();
    await vi.waitFor(() => expect(webApp.MainButton.show).toHaveBeenCalled());
    expect(screen.queryByTestId('cart-bar')).not.toBeInTheDocument();
    expect(webApp.MainButton.setText).toHaveBeenCalledWith(
      expect.stringMatching(/^Savatni ochish — 12\s500/),
    );
    const handler = vi.mocked(webApp.MainButton.onClick).mock.calls[0]?.[0];
    handler?.();
    expect(nav.push).toHaveBeenCalledWith('/uz/cart');
  });
});
