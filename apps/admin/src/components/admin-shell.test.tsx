import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiError,
  installFakeApi,
  json,
  orderPage,
  orderSummary,
  renderAdmin,
  sessionFor,
  sessionHandler,
} from '@/test-utils/fake-api';
import { OrdersList } from './orders-list';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/ru',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

const ordersHandler = (call: { path: string }) =>
  call.path.startsWith('/api/v1/admin/orders') ? json(orderPage([orderSummary()])) : undefined;

const widgetConfig = (enabled: boolean, botUsername: string | null) => (call: { path: string }) =>
  call.path === '/api/v1/auth/config'
    ? json({ telegram_login_widget: { enabled, bot_username: botUsername } })
    : undefined;

const noSession = (call: { path: string }) =>
  call.path === '/api/v1/auth/session' ? apiError(401, 'session_required') : undefined;

describe('AdminShell session and role gate', () => {
  it('lets an operator through and loads orders only after the session is known', async () => {
    const api = installFakeApi(sessionHandler('operator'), ordersHandler);
    renderAdmin(<OrdersList />);
    expect(api.to('/api/v1/admin/')).toHaveLength(0);
    expect(await screen.findByText('MM-000123')).toBeInTheDocument();
    expect(api.calls[0]?.path).toBe('/api/v1/auth/session');
    expect(api.to('/api/v1/admin/orders')).toHaveLength(1);
  });

  it('lets an admin through', async () => {
    installFakeApi(sessionHandler('admin'), ordersHandler);
    renderAdmin(<OrdersList />);
    expect(await screen.findByText('MM-000123')).toBeInTheDocument();
  });

  it('shows "access denied" with logout to a customer and never requests admin data', async () => {
    const api = installFakeApi(sessionHandler('customer'), ordersHandler, (call) =>
      call.path === '/api/v1/auth/logout' ? new Response(null, { status: 204 }) : undefined,
    );
    renderAdmin(<OrdersList />);

    expect(await screen.findByRole('heading', { name: 'Доступ запрещён' })).toBeInTheDocument();
    expect(screen.queryByText('MM-000123')).not.toBeInTheDocument();
    // Let any (wrongly) scheduled effect run before asserting the negative.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.to('/api/v1/admin/')).toHaveLength(0);
    expect(api.calls.map((call) => call.path)).toEqual(['/api/v1/auth/session']);

    // The logout in the access-denied card and the one in the header both end the session.
    fireEvent.click(screen.getAllByRole('button', { name: 'Выйти' })[0] as HTMLElement);
    await waitFor(() => expect(api.to('/api/v1/auth/logout')).toHaveLength(1));
    expect(api.to('/api/v1/auth/logout')[0]?.headers.get('x-csrf-token')).toBe('csrf-1');
  });

  it('shows the same denial in uz', async () => {
    installFakeApi(sessionHandler('customer'));
    renderAdmin(<OrdersList />, 'uz');
    expect(await screen.findByRole('heading', { name: 'Ruxsat yo‘q' })).toBeInTheDocument();
  });

  it('shows sign-in (and no admin request) without a session, with the widget when enabled', async () => {
    const api = installFakeApi(noSession, widgetConfig(true, 'test_admin_bot'), ordersHandler);
    renderAdmin(<OrdersList />);

    expect(
      await screen.findByRole('heading', { name: 'Войдите через Telegram' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector('script[data-telegram-login="test_admin_bot"]')).not.toBeNull(),
    );
    const script = document.querySelector('script[data-telegram-login]');
    // Redirect mode (the callback mode needs `eval`, which the CSP forbids), with a login state.
    expect(script?.getAttribute('data-auth-url')).toMatch(
      /\/ru\/auth\/telegram\?state=[0-9a-f]{32}$/,
    );
    expect(script?.getAttribute('data-onauth')).toBeNull();
    expect(api.to('/api/v1/admin/')).toHaveLength(0);
  });

  it('says clearly that sign-in is not configured when the widget is disabled', async () => {
    const api = installFakeApi(noSession, widgetConfig(false, null));
    renderAdmin(<OrdersList />, 'uz');
    expect(await screen.findByRole('heading', { name: 'Kirish sozlanmagan' })).toBeInTheDocument();
    expect(document.querySelector('script[data-telegram-login]')).toBeNull();
    expect(api.to('/api/v1/admin/')).toHaveLength(0);
  });

  it('treats an enabled widget without a bot username as not configured', async () => {
    installFakeApi(noSession, widgetConfig(true, null));
    renderAdmin(<OrdersList />);
    expect(await screen.findByRole('heading', { name: 'Вход не настроен' })).toBeInTheDocument();
  });

  it('offers a retry when the auth config cannot be loaded', async () => {
    let attempts = 0;
    installFakeApi(noSession, (call) => {
      if (call.path !== '/api/v1/auth/config') return undefined;
      attempts += 1;
      return attempts === 1
        ? apiError(503, 'service_unavailable')
        : json({ telegram_login_widget: { enabled: false, bot_username: null } });
    });
    renderAdmin(<OrdersList />);
    fireEvent.click(await screen.findByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('heading', { name: 'Вход не настроен' })).toBeInTheDocument();
  });

  it('shows an error with retry (and no admin request) when the session check fails', async () => {
    let attempts = 0;
    const api = installFakeApi((call) => {
      if (call.path !== '/api/v1/auth/session') return undefined;
      attempts += 1;
      return attempts === 1 ? apiError(503, 'service_unavailable') : json(sessionFor('customer'));
    });
    renderAdmin(<OrdersList />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Сервис временно недоступен');
    expect(api.to('/api/v1/admin/')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('heading', { name: 'Доступ запрещён' })).toBeInTheDocument();
    expect(api.to('/api/v1/admin/')).toHaveLength(0);
  });

  it('says so when the account is blocked', async () => {
    installFakeApi(() => apiError(403, 'account_blocked'));
    renderAdmin(<OrdersList />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ваша учётная запись заблокирована.',
    );
  });

  it('drops back to sign-in when an admin request reveals the session ended', async () => {
    installFakeApi(
      sessionHandler('operator'),
      (call) =>
        call.path.startsWith('/api/v1/admin/orders')
          ? apiError(401, 'session_required')
          : undefined,
      widgetConfig(false, null),
    );
    renderAdmin(<OrdersList />);
    expect(await screen.findByRole('heading', { name: 'Вход не настроен' })).toBeInTheDocument();
    expect(screen.queryByText('MM-000123')).not.toBeInTheDocument();
  });

  it('links the language switcher to the other locale', async () => {
    installFakeApi(sessionHandler('customer'));
    renderAdmin(<OrdersList />);
    await screen.findByRole('heading', { name: 'Доступ запрещён' });
    expect(screen.getByRole('link', { name: 'O‘zbekcha' })).toHaveAttribute('href', '/uz');
  });
});
