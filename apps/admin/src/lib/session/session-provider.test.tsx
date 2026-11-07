import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, installFakeApi, json, sessionFor, sessionHandler } from '@/test-utils/fake-api';
import { SessionProvider, useSession, type SessionContextValue } from './session-provider';

let latest: SessionContextValue | null = null;

function Probe() {
  const value = useSession();
  useEffect(() => {
    latest = value;
  }, [value]);
  return (
    <p data-testid="state">
      {value.status}:{value.user?.role ?? '-'}:{String(value.isStaff)}
    </p>
  );
}

function renderProbe() {
  return render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
}

function session(): SessionContextValue {
  if (latest === null) throw new Error('provider not rendered');
  return latest;
}

afterEach(() => {
  latest = null;
  vi.unstubAllGlobals();
});

describe('SessionProvider', () => {
  it('establishes the session from GET /auth/session', async () => {
    const api = installFakeApi(sessionHandler('operator'));
    renderProbe();
    expect(screen.getByTestId('state')).toHaveTextContent('loading');
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authenticated:operator:true'),
    );
    expect(api.to('/api/v1/auth/session')).toHaveLength(1);
    expect(api.calls[0]?.headers.get('x-csrf-token')).toBeNull();
  });

  it('treats a customer as signed in but not staff', async () => {
    installFakeApi(sessionHandler('customer'));
    renderProbe();
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authenticated:customer:false'),
    );
  });

  it('treats 401 as anonymous and other failures as an error', async () => {
    installFakeApi(() => apiError(401, 'session_required'));
    const { unmount } = renderProbe();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('anonymous'));
    unmount();

    installFakeApi(() => apiError(403, 'account_blocked'));
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));
    expect(session().error?.code).toBe('account_blocked');
  });

  it('sends the in-memory CSRF token on unsafe methods only', async () => {
    const api = installFakeApi(sessionHandler('operator', 'tok-1'), () => json({ ok: true }));
    renderProbe();
    await waitFor(() => expect(session().status).toBe('authenticated'));

    await act(() => session().apiFetch('/admin/orders'));
    await act(() => session().apiFetch('/admin/orders/x/status', { method: 'PATCH', body: '{}' }));

    const [get, patch] = api.to('/api/v1/admin/orders');
    expect(get?.headers.get('x-csrf-token')).toBeNull();
    expect(patch?.headers.get('x-csrf-token')).toBe('tok-1');
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('refreshes the session once and retries once on csrf_failed', async () => {
    let session_calls = 0;
    let patches = 0;
    const api = installFakeApi(
      (call) => {
        if (call.path !== '/api/v1/auth/session') return undefined;
        session_calls += 1;
        return json(sessionFor('operator', session_calls === 1 ? 'old' : 'fresh'));
      },
      (call) => {
        if (call.method !== 'PATCH') return undefined;
        patches += 1;
        return call.headers.get('x-csrf-token') === 'fresh'
          ? json({ ok: true })
          : apiError(403, 'csrf_failed');
      },
    );
    renderProbe();
    await waitFor(() => expect(session().status).toBe('authenticated'));

    const response = await act(() =>
      session().apiFetch('/admin/orders/x/status', { method: 'PATCH', body: '{}' }),
    );
    expect(response.status).toBe(200);
    expect(patches).toBe(2);
    expect(api.to('/api/v1/auth/session')).toHaveLength(2);
  });

  it('does not retry a CSRF failure forever', async () => {
    let patches = 0;
    installFakeApi(sessionHandler('operator'), () => {
      patches += 1;
      return apiError(403, 'csrf_failed');
    });
    renderProbe();
    await waitFor(() => expect(session().status).toBe('authenticated'));
    const response = await act(() =>
      session().apiFetch('/admin/orders/x/status', { method: 'PATCH', body: '{}' }),
    );
    expect(response.status).toBe(403);
    expect(patches).toBe(2);
  });

  it('falls back to anonymous when an admin request answers 401 (session ended)', async () => {
    installFakeApi(sessionHandler('operator'), () => apiError(401, 'session_required'));
    renderProbe();
    await waitFor(() => expect(session().status).toBe('authenticated'));
    await act(() => session().apiFetch('/admin/orders'));
    expect(screen.getByTestId('state')).toHaveTextContent('anonymous');
  });

  it('rejects with a network error when there is no response', async () => {
    installFakeApi(sessionHandler('operator'), () => {
      throw new TypeError('failed');
    });
    renderProbe();
    await waitFor(() => expect(session().status).toBe('authenticated'));
    await expect(session().apiFetch('/admin/orders')).rejects.toMatchObject({
      code: 'network_error',
    });
  });

  it('starts the Telegram sign-in: posts return_to and resolves with the authorization URL', async () => {
    const url = 'https://oauth.telegram.org/auth?response_type=code&client_id=1';
    const api = installFakeApi(
      (call) =>
        call.path === '/api/v1/auth/session' ? apiError(401, 'session_required') : undefined,
      (call) =>
        call.method === 'POST' && call.path === '/api/v1/auth/telegram/oidc/start'
          ? json({ authorization_url: url })
          : undefined,
    );
    renderProbe();
    await waitFor(() => expect(session().status).toBe('anonymous'));

    let result = '';
    await act(async () => {
      result = await session().startTelegramLogin('/ru');
    });
    expect(result).toBe(url);
    expect(api.to('/api/v1/auth/telegram/oidc/start')[0]?.body).toEqual({ return_to: '/ru' });
    // Starting creates no session by itself.
    expect(session().status).toBe('anonymous');
  });

  it('rejects a failed sign-in start with the API error, without changing the state', async () => {
    installFakeApi(
      (call) =>
        call.path === '/api/v1/auth/session' ? apiError(401, 'session_required') : undefined,
      () => apiError(429, 'rate_limited'),
    );
    renderProbe();
    await waitFor(() => expect(session().status).toBe('anonymous'));
    await expect(session().startTelegramLogin('/uz')).rejects.toMatchObject({
      code: 'rate_limited',
    });
    expect(session().status).toBe('anonymous');
  });

  it('refuses an authorization URL that is not absolute http(s)', async () => {
    installFakeApi(
      (call) =>
        call.path === '/api/v1/auth/session' ? apiError(401, 'session_required') : undefined,
      () => json({ authorization_url: 'javascript:alert(1)' }),
    );
    renderProbe();
    await waitFor(() => expect(session().status).toBe('anonymous'));
    await expect(session().startTelegramLogin('/uz')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('logs out with the CSRF token and forgets the user', async () => {
    const api = installFakeApi(sessionHandler('operator', 'tok-9'), (call) =>
      call.path === '/api/v1/auth/logout' ? new Response(null, { status: 204 }) : undefined,
    );
    renderProbe();
    await waitFor(() => expect(session().status).toBe('authenticated'));
    await act(() => session().logout());
    expect(api.to('/api/v1/auth/logout')[0]?.headers.get('x-csrf-token')).toBe('tok-9');
    expect(screen.getByTestId('state')).toHaveTextContent('anonymous:-:false');
  });
});
