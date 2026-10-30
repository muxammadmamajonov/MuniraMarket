'use client';

import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { TelegramWebApp } from './types';
import { getTelegramWebApp, isTelegramMiniApp } from './webapp';

export type TelegramContextValue =
  | {
      kind: 'telegram';
      webApp: TelegramWebApp;
      /**
       * Raw signed init data, to be forwarded to the server for verification
       * (`TelegramInitDataAuthRequest.init_data`). Do not parse or trust it client-side.
       */
      initData: string;
    }
  | { kind: 'browser' };

const BROWSER: TelegramContextValue = { kind: 'browser' };

let cachedTelegram: Extract<TelegramContextValue, { kind: 'telegram' }> | null = null;

/** Stable snapshot: the same object is returned until the WebApp object or initData changes. */
function getSnapshot(): TelegramContextValue {
  const webApp = getTelegramWebApp();
  if (webApp === null || !isTelegramMiniApp()) return BROWSER;
  if (cachedTelegram?.webApp !== webApp || cachedTelegram.initData !== webApp.initData) {
    cachedTelegram = { kind: 'telegram', webApp, initData: webApp.initData };
  }
  return cachedTelegram;
}

function getServerSnapshot(): TelegramContextValue {
  return BROWSER;
}

// `window.Telegram` is defined by a script that the root layout loads with `beforeInteractive`,
// i.e. before hydration, and it never changes afterwards, so there is nothing to subscribe to.
function subscribe(): () => void {
  return () => undefined;
}

const TelegramContext = createContext<TelegramContextValue | null>(null);

/**
 * Detects the Telegram Mini App environment. The server and the first hydration render use the
 * `browser` value, then React switches to the real value on the client without a mismatch.
 */
export function TelegramProvider({ children }: { children: ReactNode }) {
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const webApp = value.kind === 'telegram' ? value.webApp : null;
  useEffect(() => {
    if (webApp === null) return;
    webApp.ready();
    webApp.expand();
  }, [webApp]);

  return <TelegramContext.Provider value={value}>{children}</TelegramContext.Provider>;
}

export function useTelegram(): TelegramContextValue {
  const value = useContext(TelegramContext);
  if (value === null) throw new Error('useTelegram must be used inside <TelegramProvider>.');
  return value;
}
