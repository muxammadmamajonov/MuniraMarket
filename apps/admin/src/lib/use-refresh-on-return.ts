'use client';

import { useEffect, useRef } from 'react';

/** Never refetch more often than this because of focus/visibility events. */
const MIN_GAP_MS = 10_000;
/** Background poll while the page is visible, so a tab left open still shows the next order. */
const POLL_MS = 30_000;

/**
 * Calls `refresh` when the operator returns to the tab (visibility or window focus) and every
 * 30 s while the tab is visible. Never while hidden, and never twice within 10 s, so a focus
 * and a visibility event firing together cost one request. `refresh` should reload silently.
 */
export function useRefreshOnReturn(refresh: () => void, enabled = true): void {
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;
    let last = Date.now();
    const run = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - last < MIN_GAP_MS) return;
      last = now;
      latest.current();
    };
    document.addEventListener('visibilitychange', run);
    window.addEventListener('focus', run);
    const timer = window.setInterval(run, POLL_MS);
    return () => {
      document.removeEventListener('visibilitychange', run);
      window.removeEventListener('focus', run);
      window.clearInterval(timer);
    };
  }, [enabled]);
}
