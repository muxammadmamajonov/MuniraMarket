'use client';

import type {
  SessionResponse,
  TelegramInitDataAuthRequest,
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
import { reportNetworkFailure, reportNetworkSuccess } from '@/lib/network-status';
import { useTelegram } from '@/lib/telegram';

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous' | 'error';

export interface SessionContextValue {
  status: SessionStatus;
  user: UserPublic | null;
  /** Why `status` is `error`; otherwise `null`. */
  error: ApiRequestError | null;
  /**
   * `fetch` for same-origin API calls. `path` is relative to `/api/v1` (for example `/cart`).
   * Sends the session cookie, adds `X-CSRF-Token` on unsafe methods and, on a 403 `csrf_failed`,
   * refreshes the session once and retries once. Resolves with the raw `Response` (also for
   * non-2xx); rejects with a network {@link ApiRequestError} when there is no response.
   */
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** Re-runs session establishment (cookie check, then Mini App init-data login). */
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

/** `fetch` against the same-origin API, reporting reachability to the offline banner. */
async function sameOriginFetch(path: string, init: RequestInit): Promise<Response> {
  try {
    const response = await fetch(apiPath(path), { ...init, credentials: 'same-origin' });
    reportNetworkSuccess();
    return response;
  } catch (cause) {
    reportNetworkFailure();
    throw ApiRequestError.network(cause);
  }
}

async function readOutcome(response: Response): Promise<Outcome> {
  if (response.ok) return { kind: 'ok', session: await readJson<SessionResponse>(response) };
  return { kind: 'error', error: await ApiRequestError.fromResponse(response) };
}

/**
 * 1. `GET /auth/session`. 200 -> signed in.
 * 2. 401 and we run inside Telegram -> `POST /auth/telegram/init-data` with the raw signed
 *    `initData` string only. Identity comes from the server verifying that signature; nothing from
 *    `initDataUnsafe` (such as `user.id`) is ever sent.
 * 3. 401 in a plain browser -> anonymous (browsing still works).
 */
async function establishSession(initData: string): Promise<Outcome> {
  try {
    const session = await sameOriginFetch('/auth/session', {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    // 200 -> signed in; anything but 401 -> a real error (401 is the normal "no session" answer).
    if (session.status !== 401) return await readOutcome(session);
    if (initData === '') return { kind: 'anonymous' };

    const body: TelegramInitDataAuthRequest = { init_data: initData };
    const login = await sameOriginFetch('/auth/telegram/init-data', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    return await readOutcome(login);
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
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    return code === 'csrf_failed';
  } catch {
    return false;
  }
}

/**
 * Holds the browser session. The CSRF token lives in memory only (never localStorage), the
 * session cookie itself is HttpOnly and managed by the browser.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const telegram = useTelegram();
  const initData = telegram.kind === 'telegram' ? telegram.initData : '';

  const [state, setState] = useState<SessionState>(LOADING);
  const [attempt, setAttempt] = useState(0);
  const csrfToken = useRef<string | null>(null);
  const initDataRef = useRef(initData);

  useEffect(() => {
    initDataRef.current = initData;
  }, [initData]);

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

  // Establish the session on mount, and again when Telegram's init data becomes available (the
  // first render is always the "browser" snapshot) or the user retries.
  useEffect(() => {
    let cancelled = false;
    // Start on the next tick: right after hydration the Telegram snapshot flips from "browser" to
    // the real value and re-runs this effect, which would otherwise send a wasted first request.
    const timer = setTimeout(() => {
      void establishSession(initData).then((outcome) => {
        if (!cancelled) apply(outcome);
      });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [initData, attempt, apply]);

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

      const response = await send();
      if (!unsafe || response.status !== 403 || !(await isCsrfFailure(response))) return response;

      // The token is stale (session rotated or expired): refresh it once and retry once.
      const outcome = await establishSession(initDataRef.current);
      apply(outcome);
      return outcome.kind === 'ok' ? send() : response;
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
      apply({ kind: 'ok', session: await readJson<SessionResponse>(response) });
    },
    [apply],
  );

  const logout = useCallback(async (): Promise<void> => {
    const response = await apiFetch('/auth/logout', { method: 'POST' });
    // 401 means the session is already gone, which is the state we want.
    if (!response.ok && response.status !== 401) throw await ApiRequestError.fromResponse(response);
    apply({ kind: 'anonymous' });
  }, [apiFetch, apply]);

  const value = useMemo<SessionContextValue>(
    () => ({ ...state, apiFetch, retry, loginWithWidget, logout }),
    [state, apiFetch, retry, loginWithWidget, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside <SessionProvider>.');
  return value;
}
