'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * Runs at most one async action at a time. The guard is a ref, so a second click that lands
 * before React re-renders the disabled button is dropped too. `run` resolves with the action's
 * result, or `undefined` when it was dropped.
 */
export function useSingleFlight() {
  const flying = useRef(false);
  const [pending, setPending] = useState(false);

  const run = useCallback(async <T>(action: () => Promise<T>): Promise<T | undefined> => {
    if (flying.current) return undefined;
    flying.current = true;
    setPending(true);
    try {
      return await action();
    } finally {
      flying.current = false;
      setPending(false);
    }
  }, []);

  return { pending, run };
}
