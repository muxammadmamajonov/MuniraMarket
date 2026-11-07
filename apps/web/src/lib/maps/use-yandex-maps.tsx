'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n/context';
import { MapsLoadError, loadYandexMaps, type MapsLoadErrorKind } from './yandex-loader';
import type { YMaps3 } from './yandex-types';

const MapsKeyContext = createContext<string | null>(null);

/** Hands the (public, referrer-restricted) key read by the root layout to the picker. */
export function MapsConfigProvider({
  apiKey,
  children,
}: {
  apiKey: string | null;
  children: ReactNode;
}) {
  return <MapsKeyContext.Provider value={apiKey}>{children}</MapsKeyContext.Provider>;
}

/** The configured key (or `null`), for the picker's reverse-geocoding request. */
export function useYandexMapsApiKey(): string | null {
  return useContext(MapsKeyContext);
}

export type YandexMapsState =
  | { status: 'missing-key' }
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; api: YMaps3 }
  | { status: 'error'; kind: MapsLoadErrorKind };

/**
 * The map API's load state. Nothing loads until `enabled` (the picker is open); without a key
 * the state is `missing-key` and nothing ever loads. `retry` starts a fresh attempt after an
 * error.
 */
export function useYandexMaps(enabled: boolean): [YandexMapsState, () => void] {
  const apiKey = useContext(MapsKeyContext);
  const { locale } = useI18n();
  const [attempt, setAttempt] = useState(0);
  // The outcome of one load attempt; anything older than the current attempt counts as loading.
  const [outcome, setOutcome] = useState<{
    attempt: number;
    state: Extract<YandexMapsState, { status: 'ready' | 'error' }>;
  } | null>(null);

  useEffect(() => {
    if (apiKey === null || !enabled) return undefined;
    let cancelled = false;
    loadYandexMaps({ apiKey, locale }).then(
      (api) => {
        if (!cancelled) setOutcome({ attempt, state: { status: 'ready', api } });
      },
      (error: unknown) => {
        if (cancelled) return;
        const kind = error instanceof MapsLoadError ? error.kind : 'script';
        setOutcome({ attempt, state: { status: 'error', kind } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [apiKey, locale, enabled, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  let state: YandexMapsState;
  if (apiKey === null) state = { status: 'missing-key' };
  else if (outcome !== null && outcome.attempt === attempt) state = outcome.state;
  else state = enabled ? { status: 'loading' } : { status: 'idle' };
  return [state, retry];
}
