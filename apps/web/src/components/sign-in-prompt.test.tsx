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
  loginWithWidget: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ useSession: () => session }));

function renderPrompt() {
  return render(
    <LocaleProvider locale="uz">
      <TelegramProvider>
        <SignInPrompt />
      </TelegramProvider>
    </LocaleProvider>,
  );
}

function authConfig(enabled: boolean, botUsername: string | null) {
  session.apiFetch.mockResolvedValue(
    Response.json({ telegram_login_widget: { enabled, bot_username: botUsername } }),
  );
}

beforeEach(() => {
  session.status = 'anonymous';
  session.error = null;
  session.apiFetch.mockReset();
  session.retry.mockReset();
});

afterEach(() => {
  uninstallWebApp();
});

describe('SignInPrompt', () => {
  it('in a browser with the widget disabled, asks to open the shop in Telegram', async () => {
    authConfig(false, null);
    renderPrompt();
    expect(screen.getByRole('status')).toHaveTextContent('Telegram orqali oching');
    await waitFor(() => expect(session.apiFetch).toHaveBeenCalledWith('/auth/config'));
    expect(screen.queryByTestId('telegram-login-widget')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('in a browser with the widget enabled, renders the official widget script for the bot', async () => {
    authConfig(true, 'muniramarket_test_bot');
    renderPrompt();
    const container = await screen.findByTestId('telegram-login-widget');
    const script = container.querySelector('script');
    expect(script).not.toBeNull();
    expect(script?.src).toBe('https://telegram.org/js/telegram-widget.js?22');
    expect(script?.getAttribute('data-telegram-login')).toBe('muniramarket_test_bot');
    // `data-onauth` would need eval, which the CSP forbids: the redirect mode is used instead.
    expect(script?.hasAttribute('data-onauth')).toBe(false);
    // A fresh one-time state binds the redirect to this tab (login CSRF defence).
    expect(script?.getAttribute('data-auth-url')).toMatch(
      new RegExp(`^${window.location.origin}/uz/auth/telegram\\?state=[0-9a-f]{32}$`),
    );
  });

  it('never renders the widget for a suspicious bot username', async () => {
    authConfig(true, 'bad"><img src=x onerror=alert(1)>');
    renderPrompt();
    const container = await screen.findByTestId('telegram-login-widget');
    expect(container.querySelector('script')).toBeNull();
  });

  it('shows the widget only when the config call succeeded', async () => {
    session.apiFetch.mockRejectedValue(ApiRequestError.network());
    renderPrompt();
    await waitFor(() => expect(session.apiFetch).toHaveBeenCalled());
    expect(screen.queryByTestId('telegram-login-widget')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Telegram orqali oching');
  });

  it('inside the Mini App shows a retry instead of the widget and does not fetch the config', () => {
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
