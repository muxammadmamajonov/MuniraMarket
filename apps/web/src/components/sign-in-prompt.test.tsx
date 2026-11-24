import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { ApiRequestError } from '@/lib/api/errors';
import { TelegramProvider } from '@/lib/telegram';
import { installWebApp, makeWebApp, uninstallWebApp } from '@/lib/telegram/test-helpers';
import { SignInPrompt } from './sign-in-prompt';

const session = vi.hoisted(() => ({
  status: 'anonymous' as 'loading' | 'authenticated' | 'anonymous' | 'error',
  user: null,
  error: null as unknown,
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  retry: vi.fn(),
  startTelegramLogin: vi.fn<(returnTo: string) => Promise<string>>(),
  logout: vi.fn(),
}));

const navigation = vi.hoisted(() => ({ navigateTo: vi.fn<(url: string) => void>() }));

vi.mock('@/lib/session', () => ({ useSession: () => session }));
vi.mock('@/lib/auth/navigate', () => navigation);

function renderPrompt() {
  return render(
    <LocaleProvider locale="uz">
      <TelegramProvider>
        <SignInPrompt />
      </TelegramProvider>
    </LocaleProvider>,
  );
}

function authConfig(enabled: boolean) {
  session.apiFetch.mockResolvedValue(Response.json({ telegram_oidc: { enabled } }));
}

const AUTHORIZATION_URL =
  'https://oauth.telegram.org/auth?response_type=code&client_id=1&state=s&nonce=n';

beforeEach(() => {
  session.status = 'anonymous';
  session.error = null;
  session.apiFetch.mockReset();
  session.retry.mockReset();
  session.startTelegramLogin.mockReset();
  navigation.navigateTo.mockReset();
  window.history.replaceState(null, '', '/uz/cart?from=tile');
});

afterEach(() => {
  uninstallWebApp();
});

describe('SignInPrompt', () => {
  it('in a browser with Telegram sign-in disabled, asks to open the shop in Telegram', async () => {
    authConfig(false);
    renderPrompt();
    expect(screen.getByRole('status')).toHaveTextContent('Telegram orqali oching');
    await waitFor(() => expect(session.apiFetch).toHaveBeenCalledWith('/auth/config'));
    expect(screen.queryByTestId('telegram-login-button')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('in a browser with Telegram sign-in enabled, shows the custom sign-in button', async () => {
    authConfig(true);
    renderPrompt();
    const button = await screen.findByRole('button', { name: 'Telegram orqali kirish' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-busy', 'false');
    expect(button.className).toContain('min-h-12');
    expect(button.className).toContain('focus-visible:outline');
    // No Telegram script or iframe is ever injected.
    expect(document.querySelector('script[src*="telegram"]')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('starts the sign-in with the current page as return_to, then navigates top-level', async () => {
    authConfig(true);
    let resolve: (url: string) => void = () => undefined;
    session.startTelegramLogin.mockReturnValue(
      new Promise<string>((done) => {
        resolve = done;
      }),
    );
    renderPrompt();
    const button = await screen.findByRole('button', { name: 'Telegram orqali kirish' });
    fireEvent.click(button);

    expect(session.startTelegramLogin).toHaveBeenCalledWith('/uz/cart?from=tile');
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveTextContent('Telegramga o‘tilmoqda…');
    // A second click while starting does nothing.
    fireEvent.click(button);
    expect(session.startTelegramLogin).toHaveBeenCalledOnce();

    resolve(AUTHORIZATION_URL);
    await waitFor(() => expect(navigation.navigateTo).toHaveBeenCalledWith(AUTHORIZATION_URL));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    [new ApiRequestError({ status: 429, code: 'rate_limited', message: 'x' }), 'Juda ko‘p urinish'],
    [
      new ApiRequestError({ status: 404, code: 'feature_disabled', message: 'x' }),
      'hozircha mavjud emas',
    ],
    [ApiRequestError.network(), 'Xizmat vaqtincha ishlamayapti'],
    [
      new ApiRequestError({ status: 503, code: 'service_unavailable', message: 'x' }),
      'ishlamayapti',
    ],
    [new ApiRequestError({ status: 403, code: 'csrf_failed', message: 'x' }), 'boshlab bo‘lmadi'],
  ])('shows an inline alert when the start fails (%s)', async (error, text) => {
    authConfig(true);
    session.startTelegramLogin.mockRejectedValue(error);
    renderPrompt();
    const button = await screen.findByRole('button', { name: 'Telegram orqali kirish' });
    fireEvent.click(button);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(text);
    expect(button).toHaveAttribute('aria-busy', 'false');
    expect(button).toHaveAttribute('aria-describedby', alert.id);
    expect(navigation.navigateTo).not.toHaveBeenCalled();
  });

  it('shows the button only when the config call succeeded', async () => {
    session.apiFetch.mockRejectedValue(ApiRequestError.network());
    renderPrompt();
    await waitFor(() => expect(session.apiFetch).toHaveBeenCalled());
    expect(screen.queryByTestId('telegram-login-button')).toBeNull();
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Kirish usullarini yuklab bo‘lmadi.',
    );
    expect(screen.getByRole('button', { name: 'Qayta urinish' })).toBeInTheDocument();
  });

  it('inside the Mini App shows a retry instead of the sign-in button and does not fetch the config', () => {
    installWebApp(makeWebApp());
    session.status = 'error';
    renderPrompt();
    expect(screen.getByRole('status')).toHaveTextContent('Telegram orqali kirib bo‘lmadi.');
    expect(session.apiFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Qayta urinish' }));
    expect(session.retry).toHaveBeenCalledOnce();
  });

  it('explains a blocked account', () => {
    installWebApp(makeWebApp());
    session.status = 'error';
    session.error = new ApiRequestError({ status: 403, code: 'account_blocked', message: 'x' });
    renderPrompt();
    expect(screen.getByRole('status')).toHaveTextContent('bloklangan');
  });

  it('offers a retry after a service error in a browser', () => {
    session.status = 'error';
    session.error = ApiRequestError.network();
    renderPrompt();
    expect(screen.getByRole('status')).toHaveTextContent('Xizmat vaqtincha ishlamayapti');
    fireEvent.click(screen.getByRole('button', { name: 'Qayta urinish' }));
    expect(session.retry).toHaveBeenCalledOnce();
  });
});
