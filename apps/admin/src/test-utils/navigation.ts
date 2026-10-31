import { useMemo, useSyncExternalStore } from 'react';

/**
 * A small stateful stand-in for `next/navigation`: `router.replace/push` really change the path and
 * query, and every hook re-renders, so list screens whose filters live in the URL can be tested.
 *
 *   vi.mock('next/navigation', async () => await import('@/test-utils/navigation'));
 */
const state = { path: '/ru', search: '' };
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Resets the location; `url` is a path with an optional `?query`. */
export function setLocation(url: string): void {
  const [path = '/ru', search = ''] = url.split('?');
  state.path = path;
  state.search = search;
  notify();
}

export const useSearchParams = () => {
  const search = useSyncExternalStore(
    subscribe,
    () => state.search,
    () => state.search,
  );
  return useMemo(() => new URLSearchParams(search), [search]);
};

export const usePathname = () =>
  useSyncExternalStore(
    subscribe,
    () => state.path,
    () => state.path,
  );

const go = (url: string) => setLocation(url);
const router = { replace: go, push: go, back: () => undefined, refresh: () => undefined };
export const useRouter = () => router;
