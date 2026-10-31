'use client';

import type {
  SessionResponse,
  TelegramLoginWidgetPayload,
  UserPublic,
} from '@muniramarket/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiRequestError, apiPath, readJson } from '@/lib/api/errors';
import { isAdmin, isStaff } from '@/lib/roles';

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous' | 'error';

export interface SessionContextValue {
  status: SessionStatus;
  user: UserPublic | null;
  /** True only for a signed-in operator/admin. Everything that reads order data is gated on it. */
  isStaff: boolean;
  /**
   * True only for a signed-in admin. UI convenience (navigation, admin-only pages): Core API
   * re-reads the role on every request and answers 403 to an operator regardless.
   */
  isAdmin: boolean;
  /** Why `status` is `error`; otherwise `null`. */
  error: ApiRequestError | null;
  /**
   * `fetch` for same-origin API calls. `path` is relative to `/api/v1` (for example
   * `/admin/orders`). Sends the session cookie, adds `X-CSRF-Token` on unsafe methods and, on a
   * 403 `csrf_failed`, refreshes the session once and retries once. A 401 from anything but the
   * `/auth/*` routes means the session is gone: the provider moves to `anonymous` (the gate then
   * shows sign-in). Resolves with the raw `Response` (also for non-2xx); rejects with a network
   * {@link ApiRequestError} when there is no response.
   */
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** Re-runs session establishment. */
  retry: () => void;
  /** Completes a Telegram Login Widget login. Rejects with {@link ApiRequestError}. */
  loginWithWidget: (payload: TelegramLoginWidgetPayload) => Promise<void>;
  /** Ends the session on the server and forgets the CSRF token. */
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

interface SessionState {
  status: SessionStatus;
  user: UserPublic | null;
  error: ApiRequestError | null;
}

const LOADING: SessionState = { status: 'loading', user: null, error: null };

type Outcome =
  | { kind: 'ok'; session: SessionResponse }
  | { kind: 'anonymous' }
  | { kind: 'error'; error: ApiRequestError };

const JSON_HEADERS = { accept: 'application/json', 'content-type': 'application/json' } as const;
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * `fetch` against the same-origin API. No `mode` is set on purpose: the default (`cors`, which for
 * a same-origin URL is just a normal request) is what makes the browser send `Origin` on unsafe
 * methods even under `Referrer-Policy: no-referrer`; Core API's CSRF check needs it.
 */
async function sameOriginFetch(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(apiPath(path), { ...init, credentials: 'same-origin' });
  } catch (cause) {
    throw ApiRequestError.network(cause);
  }
}

async function readOutcome(response: Response): Promise<Outcome> {
  if (response.ok) return { kind: 'ok', session: await readJson<SessionResponse>(response) };
  return { kind: 'error', error: await ApiRequestError.fromResponse(response) };
}

/** `GET /auth/session`: 200 -> signed in, 401 -> anonymous, anything else -> an error. */
async function establishSession(): Promise<Outcome> {
  try {
    const response = await sameOriginFetch('/auth/session', {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (response.status === 401) return { kind: 'anonymous' };
    return await readOutcome(response);
  } catch (error) {
    return {
      kind: 'error',
      error: error instanceof ApiRequestError ? error : ApiRequestError.network(error),
    };
  }
}

async function isCsrfFailure(response: Response): Promise<boolean> {
  try {
    const body: unknown = await response.clone().json();
    return (body as { error?: { code?: unknown } } | null)?.error?.code === 'csrf_failed';
  } catch {
    return false;
  }
}

/**
 * Holds the browser session. The CSRF token lives in memory only (never localStorage); the session
 * cookie itself is HttpOnly and managed by the browser. Whether the user may see order data is
 * decided by `isStaff` (see `components/admin-shell.tsx`) and, independently, by Core API.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>(LOADING);
  const [attempt, setAttempt] = useState(0);
  const csrfToken = useRef<string | null>(null);
  /**
   * Bumped whenever the session is decided by something other than the establishing request
   * (login, logout, a 401). A slow `GET /auth/session` that started earlier must not overwrite
   * that newer result, e.g. the callback page's login racing the initial session check.
   */
  const epoch = useRef(0);

  const apply = useCallback((outcome: Outcome) => {
    if (outcome.kind === 'ok') {
      csrfToken.current = outcome.session.csrf_token;
      setState({ status: 'authenticated', user: outcome.session.user, error: null });
    } else if (outcome.kind === 'anonymous') {
      csrfToken.current = null;
      setState({ status: 'anonymous', user: null, error: null });
    } else {
      csrfToken.current = null;
      setState({ status: 'error', user: null, error: outcome.error });
    }
  }, []);

  // Establish the session on mount and whenever the user retries.
  useEffect(() => {
    let cancelled = false;
    const started = epoch.current;
    void establishSession().then((outcome) => {
      if (!cancelled && started === epoch.current) apply(outcome);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt, apply]);

  const apiFetch = useCallback(
    async (path: string, init: RequestInit = {}): Promise<Response> => {
      const method = (init.method ?? 'GET').toUpperCase();
      const unsafe = UNSAFE_METHODS.has(method);

      const send = (): Promise<Response> => {
        const headers = new Headers(init.headers);
        if (!headers.has('accept')) headers.set('accept', 'application/json');
        if (unsafe && csrfToken.current !== null) headers.set('X-CSRF-Token', csrfToken.current);
        return sameOriginFetch(path, { ...init, method, headers });
      };

      let response = await send();
      if (unsafe && response.status === 403 && (await isCsrfFailure(response))) {
        // The token is stale (session rotated or expired): refresh it once and retry once.
        const outcome = await establishSession();
        apply(outcome);
        if (outcome.kind === 'ok') response = await send();
      }

      if (response.status === 401 && !path.startsWith('/auth/')) {
        // The session ended (expired, logged out elsewhere): back to sign-in.
        epoch.current += 1;
        apply({ kind: 'anonymous' });
      }
      return response;
    },
    [apply],
  );

  const retry = useCallback(() => {
    setState(LOADING);
    setAttempt((value) => value + 1);
  }, []);

  const loginWithWidget = useCallback(
    async (payload: TelegramLoginWidgetPayload): Promise<void> => {
      const response = await sameOriginFetch('/auth/telegram/login-widget', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw await ApiRequestError.fromResponse(response);
      const session = await readJson<SessionResponse>(response);
      epoch.current += 1;
      apply({ kind: 'ok', session });
    },
    [apply],
  );

  const logout = useCallback(async (): Promise<void> => {
    const response = await apiFetch('/auth/logout', { method: 'POST' });
    // 401 means the session is already gone, which is the state we want.
    if (!response.ok && response.status !== 401) throw await ApiRequestError.fromResponse(response);
    epoch.current += 1;
    apply({ kind: 'anonymous' });
  }, [apiFetch, apply]);

  const value = useMemo<SessionContextValue>(
    () => ({
      ...state,
      isStaff: isStaff(state.user),
      isAdmin: isAdmin(state.user),
      apiFetch,
      retry,
      loginWithWidget,
      logout,
    }),
    [state, apiFetch, retry, loginWithWidget, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside <SessionProvider>.');
  return value;
}
