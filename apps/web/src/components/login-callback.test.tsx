import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { LoginCallback } from './login-callback';

const mocks = vi.hoisted(() => ({
  search: '',
  startTelegramLogin: vi.fn<(returnTo: string) => Promise<string>>(),
  navigateTo: vi.fn<(url: string) => void>(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(mocks.search),
}));
vi.mock('@/lib/session', () => ({
  useSession: () => ({ startTelegramLogin: mocks.startTelegramLogin }),
}));
vi.mock('@/lib/auth/navigate', () => ({ navigateTo: mocks.navigateTo }));

beforeEach(() => {
  mocks.search = '';
  mocks.startTelegramLogin.mockReset();
  mocks.navigateTo.mockReset();
});

function renderPage(locale: 'uz' | 'ru' = 'uz') {
  return render(
    <LocaleProvider locale={locale}>
      <LoginCallback />
    </LocaleProvider>,
  );
}

describe('LoginCallback (sign-in failure page)', () => {
  it.each([
    ['failed', 'Telegram orqali kirib bo‘lmadi'],
    ['cancelled', 'Kirish bekor qilindi'],
    ['blocked', 'Hisobingiz bloklangan'],
    ['unavailable', 'Xizmat vaqtincha ishlamayapti'],
  ])('explains status=%s', (status, text) => {
    mocks.search = `status=${status}`;
    renderPage();
    expect(screen.getByRole('heading', { name: 'Kirish amalga oshmadi' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(text);
    expect(screen.getByRole('link', { name: 'Bosh sahifaga qaytish' })).toHaveAttribute(
      'href',
      '/uz',
    );
  });

  it.each([[''], ['status=weird'], ['status=<script>'], ['code=abc&state=xyz']])(
    'treats an unknown or missing status (%j) as failed',
    (search) => {
      mocks.search = search;
      renderPage();
      expect(screen.getByRole('alert')).toHaveTextContent('Telegram orqali kirib bo‘lmadi');
    },
  );

  it('is localized in Russian', () => {
    mocks.search = 'status=cancelled';
    renderPage('ru');
    expect(screen.getByRole('heading', { name: 'Вход не выполнен' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Вход отменён.');
    expect(screen.getByRole('button', { name: 'Войти через Telegram' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'На главную' })).toHaveAttribute('href', '/ru');
  });

  it('offers a retry that starts a new sign-in returning to the cart', async () => {
    mocks.search = 'status=cancelled';
    mocks.startTelegramLogin.mockResolvedValue('https://oauth.telegram.org/auth?x=1');
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Telegram orqali kirish' }));
    expect(mocks.startTelegramLogin).toHaveBeenCalledWith('/uz/cart');
    await waitFor(() =>
      expect(mocks.navigateTo).toHaveBeenCalledWith('https://oauth.telegram.org/auth?x=1'),
    );
  });

  it('offers no retry to a blocked account', () => {
    mocks.search = 'status=blocked';
    renderPage();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
