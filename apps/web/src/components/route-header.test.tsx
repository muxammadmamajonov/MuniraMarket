import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { CartProvider } from '@/lib/cart';
import { makeCart } from '@/lib/cart/test-fixtures';
import { TelegramProvider } from '@/lib/telegram';
import { RouteHeader, type RouteHeaderProps } from './route-header';

const nav = vi.hoisted(() => ({ pathname: '/uz' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

const session = vi.hoisted(() => ({
  status: 'anonymous' as const,
  user: null,
  error: null,
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  retry: vi.fn(),
  startTelegramLogin: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ useSession: () => session }));

function renderAt(pathname: string, locale: 'uz' | 'ru' = 'uz', props: RouteHeaderProps = {}) {
  nav.pathname = pathname;
  return render(
    <LocaleProvider locale={locale}>
      <TelegramProvider>
        <CartProvider>
          <RouteHeader {...props} />
        </CartProvider>
      </TelegramProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  session.apiFetch.mockReset();
  session.apiFetch.mockResolvedValue(Response.json(makeCart()));
});

describe('RouteHeader', () => {
  it('shows the logo at home', () => {
    renderAt('/uz');
    expect(screen.getByTestId('header-logo')).toBeInTheDocument();
  });

  it('shows the title known from the URL', () => {
    renderAt('/ru/cart', 'ru');
    expect(screen.getByRole('heading', { level: 1, name: 'Корзина' })).toBeInTheDocument();
  });

  it('keeps the slot empty on a page whose title comes from data', () => {
    renderAt('/uz/p/olma');
    expect(screen.queryByTestId('header-logo')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('titles the not-found and error shells, whatever the URL', () => {
    renderAt('/uz/p/missing', 'uz', { kind: 'notFound' });
    expect(screen.getByRole('heading', { level: 1, name: 'Topilmadi' })).toBeInTheDocument();
  });
});
