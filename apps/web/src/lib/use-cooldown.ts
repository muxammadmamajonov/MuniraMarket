'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * A rate-limit cool-down: `seconds` counts down once a second from the value given to `start`
 * (the API's `Retry-After`), then stays at 0. Callers disable whatever would repeat the refused
 * request while `seconds > 0`, so a 429 is waited out rather than hammered.
 */
export function useCooldown(): { seconds: number; start: (seconds: number) => void } {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (seconds <= 0) return undefined;
    const timer = setTimeout(() => setSeconds((current) => current - 1), 1000);
    return () => clearTimeout(timer);
  }, [seconds]);

  const start = useCallback((wait: number) => setSeconds(Math.max(0, Math.ceil(wait))), []);
  return { seconds, start };
}
