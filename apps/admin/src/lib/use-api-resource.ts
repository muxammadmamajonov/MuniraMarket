'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError, readJson } from '@/lib/api/errors';
import { useSession } from '@/lib/session';

export type ResourceStatus = 'loading' | 'ready' | 'error';

export interface ApiResource<T> {
  /** `loading`: nothing to show yet. `ready`: `data` is current or being refreshed. `error`: last try failed. */
  status: ResourceStatus;
  /** The latest successful result. While a new filter/page loads it is the previous one (`fetching`). */
  data: T | null;
  error: ApiRequestError | null;
  /** A request for the current `path` is in flight (and `data`, if any, belongs to an earlier one). */
  fetching: boolean;
  /** Fetches again (retry button, after a write). The old data stays on screen meanwhile. */
  reload: () => void;
}

type Settled<T> =
  { key: string; data: T; error: null } | { key: string; data: null; error: ApiRequestError };

/**
 * GET `path` (relative to `/api/v1`) through the session's `apiFetch`. `null` disables it. A result
 * that belongs to an earlier `path` never counts as current, but it stays visible (dimmed by the
 * caller) so filtering and paging do not flash a skeleton. Stale responses are ignored.
 */
export function useApiResource<T>(path: string | null): ApiResource<T> {
  const { apiFetch } = useSession();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ settled: Settled<T> | null; lastGood: T | null }>({
    settled: null,
    lastGood: null,
  });
  const key = `${path ?? ''}|${String(attempt)}`;

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    apiFetch(path)
      .then(async (response) => {
        if (!response.ok) throw await ApiRequestError.fromResponse(response);
        return readJson<T>(response);
      })
      .then((data) => {
        if (!cancelled) setState({ settled: { key, data, error: null }, lastGood: data });
      })
      .catch((cause: unknown) => {
        const error = cause instanceof ApiRequestError ? cause : ApiRequestError.network(cause);
        if (!cancelled) setState((prev) => ({ ...prev, settled: { key, data: null, error } }));
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch, path, key]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const current = state.settled?.key === key ? state.settled : null;
  const fetching = path !== null && current === null;

  if (current?.error) {
    return { status: 'error', data: null, error: current.error, fetching: false, reload };
  }
  // After a failure only a fresh success counts: a retry shows the skeleton, not stale data.
  const data = current?.data ?? (state.settled?.error ? null : state.lastGood);
  return {
    status: data === null ? 'loading' : 'ready',
    data,
    error: null,
    fetching,
    reload,
  };
}
