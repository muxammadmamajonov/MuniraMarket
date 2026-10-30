import type { SessionResponse } from '@muniramarket/contracts';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetNetworkStatus } from '@/lib/network-status';
import { TelegramProvider } from '@/lib/telegram';
import { installWebApp, makeWebApp, uninstallWebApp } from '@/lib/telegram/test-helpers';
import { SessionProvider, useSession, type SessionContextValue } from './session-provider';

const USER = {
  id: 'u1',
  telegram_user_id: 900000001,
  first_name: 'Test',
  last_name: null,
  username: null,
  language: 'uz',
  role: 'customer',
} as const;

function session(csrf: string): SessionResponse {
  return { user: USER, csrf_token: csrf };
}

function errorBody(code: string, status: number): Response {
  return Response.json({ error: { code, message: code } }, { status });
}

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
  credentials: RequestCredentials | undefined;
}

type Handler = (call: Call) => Response | Promise<Response>;

const calls: Call[] = [];

function mockFetch(handler: Handler) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
      credentials: init?.credentials,
    };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

let latest: SessionContextValue;

function Probe() {
  const current = useSession();
  useEffect(() => {
    latest = current;
  });
  return (
    <p data-testid="status">
      {current.status}:{current.user?.first_name ?? '-'}
    </p>
  );
}

function renderSession() {
  return render(
    <TelegramProvider>
      <SessionProvider>
        <Probe />
      </SessionProvider>
    </TelegramProvider>,
  );
}

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  uninstallWebApp();
  vi.unstubAllGlobals();
  resetNetworkStatus();
});

describe('SessionProvider', () => {
  it('starts loading and becomes authenticated when the session cookie is valid', async () => {
    mockFetch(() => Response.json(session('csrf-1')));
    renderSession();
    expect(screen.getByTestId('status')).toHaveTextContent('loading');
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated:Test'),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: '/api/v1/auth/session', method: 'GET' });
    expect(calls[0]?.credentials).toBe('same-origin');
  });

  it('is anonymous on 401 in a plain browser and does not try Telegram login', async () => {
    mockFetch(() => errorBody('session_required', 401));
    renderSession();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    expect(calls.map((c) => c.url)).toEqual(['/api/v1/auth/session']);
  });

  it('on 401 inside Telegram, logs in with the raw initData only', async () => {
    const initData = 'query_id=AAA&user=%7B%22id%22%3A900000001%7D&auth_date=1&hash=abc';
    installWebApp(
      makeWebApp({
        initData,
        initDataUnsafe: { user: { id: 900000001, first_name: 'Forged' } },
      }),
    );
    mockFetch((call) =>
      call.url.endsWith('/auth/session')
        ? errorBody('session_required', 401)
        : Response.json(session('csrf-2')),
    );
    renderSession();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    const login = calls.find((c) => c.url === '/api/v1/auth/telegram/init-data');
    expect(login?.method).toBe('POST');
    expect(login?.credentials).toBe('same-origin');
    expect(JSON.parse(login?.body ?? '{}')).toEqual({ init_data: initData });
    // Nothing derived from initDataUnsafe may leave the browser.
    for (const call of calls) {
      expect(call.body ?? '').not.toContain('Forged');
      expect(call.body ?? '').not.toContain('user_id');
      expect(call.body ?? '').not.toContain('"id"');
    }
  });

  it('reports an error when Telegram login is rejected', async () => {
    installWebApp(makeWebApp());
    mockFetch((call) =>
      call.url.endsWith('/auth/session')
        ? errorBody('session_required', 401)
        : errorBody('invalid_telegram_auth', 401),
    );
    renderSession();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    expect(latest.error?.code).toBe('invalid_telegram_auth');
  });

  it('reports an error when the API is unreachable', async () => {
    mockFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    renderSession();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    expect(latest.error?.isNetworkError).toBe(true);
  });

  it('retry() runs the flow again', async () => {
    let healthy = false;
    mockFetch(() => (healthy ? Response.json(session('c')) : errorBody('internal_error', 500)));
    renderSession();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    healthy = true;
    act(() => latest.retry());
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
  });

  describe('apiFetch', () => {
    async function ready(handler: Handler) {
      mockFetch(handler);
      renderSession();
      await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
      calls.length = 0;
    }

    it('adds X-CSRF-Token on unsafe methods only, and uses same-origin credentials', async () => {
      await ready((call) =>
        call.url.endsWith('/auth/session') ? Response.json(session('csrf-A')) : Response.json({}),
      );

      await latest.apiFetch('/cart');
      await latest.apiFetch('/cart/items', { method: 'POST', body: '{}' });
      await latest.apiFetch('/cart/items/p', { method: 'put', body: '{}' });
      await latest.apiFetch('/cart/items/p', { method: 'DELETE' });

      expect(calls.map((c) => [c.method, c.headers.get('x-csrf-token')])).toEqual([
        ['GET', null],
        ['POST', 'csrf-A'],
        ['PUT', 'csrf-A'],
        ['DELETE', 'csrf-A'],
      ]);
      expect(calls.every((c) => c.credentials === 'same-origin')).toBe(true);
      expect(calls[0]?.url).toBe('/api/v1/cart');
    });

    it('on 403 csrf_failed refreshes the session once and retries once with the new token', async () => {
      let sessionCalls = 0;
      await ready((call) => {
        if (call.url.endsWith('/auth/session')) {
          sessionCalls += 1;
          return Response.json(session(sessionCalls === 1 ? 'old' : 'fresh'));
        }
        return call.headers.get('x-csrf-token') === 'fresh'
          ? Response.json({ ok: true })
          : errorBody('csrf_failed', 403);
      });

      const response = await latest.apiFetch('/cart/items', { method: 'POST', body: '{}' });
      expect(response.status).toBe(200);
      expect(
        calls.map((c) => `${c.method} ${c.url} ${c.headers.get('x-csrf-token') ?? ''}`),
      ).toEqual([
        'POST /api/v1/cart/items old',
        'GET /api/v1/auth/session ',
        'POST /api/v1/cart/items fresh',
      ]);
    });

    it('does not retry more than once when the retry also fails with csrf_failed', async () => {
      await ready((call) =>
        call.url.endsWith('/auth/session')
          ? Response.json(session('t'))
          : errorBody('csrf_failed', 403),
      );
      const response = await latest.apiFetch('/cart/items', { method: 'POST', body: '{}' });
      expect(response.status).toBe(403);
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
    });

    it('does not refresh for other 403 errors or for GET', async () => {
      await ready((call) =>
        call.url.endsWith('/auth/session')
          ? Response.json(session('t'))
          : errorBody('account_blocked', 403),
      );
      const blocked = await latest.apiFetch('/cart/items', { method: 'POST', body: '{}' });
      expect(blocked.status).toBe(403);
      expect(calls).toHaveLength(1);
    });

    it('rejects with a network error when there is no response', async () => {
      await ready((call) => {
        if (call.url.endsWith('/auth/session')) return Response.json(session('t'));
        throw new TypeError('Failed to fetch');
      });
      await expect(latest.apiFetch('/cart')).rejects.toMatchObject({ code: 'network_error' });
    });
  });

  it('logout posts with the CSRF token and returns to anonymous', async () => {
    mockFetch((call) =>
      call.url.endsWith('/auth/session')
        ? Response.json(session('csrf-L'))
        : new Response(null, { status: 204 }),
    );
    renderSession();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    await act(() => latest.logout());
    const logout = calls.find((c) => c.url === '/api/v1/auth/logout');
    expect(logout?.method).toBe('POST');
    expect(logout?.headers.get('x-csrf-token')).toBe('csrf-L');
    expect(screen.getByTestId('status')).toHaveTextContent('anonymous');
  });

  it('loginWithWidget posts the payload and authenticates', async () => {
    mockFetch((call) =>
      call.url.endsWith('/auth/session')
        ? errorBody('session_required', 401)
        : Response.json(session('csrf-W')),
    );
    renderSession();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    const payload = { id: 5, first_name: 'W', auth_date: 1, hash: 'h' };
    await act(() => latest.loginWithWidget(payload));
    const call = calls.find((c) => c.url === '/api/v1/auth/telegram/login-widget');
    expect(JSON.parse(call?.body ?? '{}')).toEqual(payload);
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
  });

  it('keeps the CSRF token out of web storage', async () => {
    mockFetch(() => Response.json(session('super-secret-csrf')));
    renderSession();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(JSON.stringify({ ...localStorage })).not.toContain('super-secret-csrf');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('super-secret-csrf');
  });
});
