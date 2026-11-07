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

function renderPage(locale: 'uz' | 'ru' = 'ru') {
  return render(
    <LocaleProvider locale={locale}>
      <LoginCallback />
    </LocaleProvider>,
  );
}

describe('LoginCallback (sign-in failure page)', () => {
  it.each([
    ['failed', 'Ссылка для входа устарела или не прошла проверку'],
    ['cancelled', 'Вход в Telegram был отклонён'],
    ['blocked', 'Ваша учётная запись заблокирована.'],
    ['unavailable', 'Сервис временно недоступен'],
  ])('explains status=%s', (status, text) => {
    mocks.search = `status=${status}`;
    renderPage();
    expect(screen.getByRole('heading', { name: 'Вход не выполнен' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(text);
    expect(screen.getByRole('link', { name: 'На главную' })).toHaveAttribute('href', '/ru');
  });

  it.each([[''], ['status=nope'], ['id=5&hash=abc']])(
    'treats an unknown or missing status (%j) as failed',
    (search) => {
      mocks.search = search;
      renderPage();
      expect(screen.getByRole('alert')).toHaveTextContent('Ссылка для входа устарела');
    },
  );

  it('is localized in Uzbek', () => {
    mocks.search = 'status=unavailable';
    renderPage('uz');
    expect(screen.getByRole('heading', { name: 'Kirish amalga oshmadi' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Xizmat vaqtincha ishlamayapti');
    expect(screen.getByRole('link', { name: 'Bosh sahifaga qaytish' })).toHaveAttribute(
      'href',
      '/uz',
    );
  });

  it('offers a retry that starts a new sign-in returning to the locale root', async () => {
    mocks.search = 'status=failed';
    mocks.startTelegramLogin.mockResolvedValue('https://oauth.telegram.org/auth?x=1');
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Попробовать снова' }));
    expect(mocks.startTelegramLogin).toHaveBeenCalledWith('/ru');
    await waitFor(() =>
      expect(mocks.navigateTo).toHaveBeenCalledWith('https://oauth.telegram.org/auth?x=1'),
    );
  });

  it('offers no retry to a blocked account', () => {
    mocks.search = 'status=blocked';
    renderPage();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the support code from ?ref= so the operator can quote it', () => {
    mocks.search = 'status=unavailable&ref=01ab23cd';
    renderPage('uz');
    expect(screen.getByTestId('support-code')).toHaveTextContent('Yordam kodi: 01ab23cd');
    expect(screen.getByText(/shu kodni administratorga/)).toBeInTheDocument();
  });

  it.each([['ref=<b>x</b>'], ['ref=0123'], ['ref=0123456789abcdef'], ['ref=ABCDEFGH']])(
    'ignores a malformed support code (%s)',
    (ref) => {
      mocks.search = `status=unavailable&${ref}`;
      renderPage();
      expect(screen.queryByTestId('support-code')).toBeNull();
    },
  );

  it('keeps the "try again" usable after a failed restart and shows that failure\'s code', async () => {
    mocks.search = 'status=unavailable';
    const { ApiRequestError } = await import('@/lib/api/errors');
    mocks.startTelegramLogin.mockRejectedValueOnce(
      new ApiRequestError({
        status: 503,
        code: 'service_unavailable',
        message: 'x',
        requestId: 'feedbeef00112233',
      }),
    );
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Попробовать снова' }));
    expect(await screen.findByTestId('login-error')).toHaveTextContent(
      'Код для поддержки: feedbeef',
    );
    expect(mocks.navigateTo).not.toHaveBeenCalled();
  });
});
