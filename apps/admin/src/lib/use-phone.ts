import { useSyncExternalStore } from 'react';

/** The admin's phone layout: 640px and below (the `sm` breakpoint starts at 641px). */
const PHONE_QUERY = '(max-width: 640px)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function snapshot(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(PHONE_QUERY).matches
    : false;
}

/**
 * Whether the phone layout is active. For structure that differs on phones (a filter sheet
 * instead of inline filters, a list instead of a table, swipe actions): rendering one or the
 * other keeps each control in the DOM once. Server render and environments without
 * `matchMedia` (tests) get the desktop layout.
 */
export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
