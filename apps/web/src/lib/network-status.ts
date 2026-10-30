'use client';

import { useSyncExternalStore } from 'react';

/**
 * Tracks whether the app looks offline: either the browser says so (`navigator.onLine`) or the
 * last API request failed without an HTTP response. `apiFetch` reports each request's outcome.
 */

let requestFailed = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function reportNetworkFailure(): void {
  if (requestFailed) return;
  requestFailed = true;
  emit();
}

export function reportNetworkSuccess(): void {
  if (!requestFailed) return;
  requestFailed = false;
  emit();
}

/** Test helper: forget any recorded failure. */
export function resetNetworkStatus(): void {
  requestFailed = false;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onOnline = () => {
    // Connectivity is back: give the app a clean slate instead of waiting for the next request.
    requestFailed = false;
    listener();
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', listener);
  };
}

function getSnapshot(): boolean {
  return requestFailed || !navigator.onLine;
}

function getServerSnapshot(): boolean {
  return false;
}

/** True while the browser is offline or the last API request could not reach the server. */
export function useIsOffline(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
