'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useTelegram } from './provider';
import type { TelegramImpactStyle, TelegramNotificationType, TelegramWebApp } from './types';

function useWebApp(): TelegramWebApp | null {
  const telegram = useTelegram();
  return telegram.kind === 'telegram' ? telegram.webApp : null;
}

/** Keeps the latest callback in a ref so effects register one stable listener. */
function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

export interface BackButtonConfig {
  visible: boolean;
  onClick: () => void;
}

/**
 * Shows Telegram's native BackButton while `visible` and calls `onClick` when it is pressed.
 * The listener is always removed and the button hidden again on cleanup. No-op in a browser.
 */
export function useBackButton({ visible, onClick }: BackButtonConfig): void {
  const webApp = useWebApp();
  const handlerRef = useLatest(onClick);

  useEffect(() => {
    if (webApp === null || !visible) return undefined;
    const button = webApp.BackButton;
    const handler = () => handlerRef.current();
    button.onClick(handler);
    button.show();
    return () => {
      button.offClick(handler);
      button.hide();
    };
  }, [webApp, visible, handlerRef]);
}

export interface MainButtonConfig {
  text: string;
  onClick: () => void;
  disabled?: boolean;
  /** Shows Telegram's progress spinner on the button. */
  loading?: boolean;
}

/**
 * Shows Telegram's native MainButton with `config` while the caller is mounted (pass `null` to
 * keep it hidden). The click listener is removed and the button hidden on cleanup, so every page
 * that does not use the button leaves it hidden. No-op in a browser.
 */
export function useMainButton(config: MainButtonConfig | null): void {
  const webApp = useWebApp();
  const active = config !== null;
  const handlerRef = useLatest(config?.onClick ?? noop);
  const text = config?.text;
  const disabled = config?.disabled ?? false;
  const loading = config?.loading ?? false;

  useEffect(() => {
    if (webApp === null || !active) return undefined;
    const button = webApp.MainButton;
    const handler = () => handlerRef.current();
    button.onClick(handler);
    button.show();
    return () => {
      button.offClick(handler);
      button.hideProgress();
      button.hide();
    };
  }, [webApp, active, handlerRef]);

  useEffect(() => {
    if (webApp === null || !active || text === undefined) return;
    const button = webApp.MainButton;
    button.setText(text);
    if (disabled) button.disable();
    else button.enable();
    if (loading) button.showProgress(false);
    else button.hideProgress();
  }, [webApp, active, text, disabled, loading]);
}

function noop(): void {
  // Placeholder while the MainButton is not in use.
}

export interface Haptics {
  impact: (style?: TelegramImpactStyle) => void;
  notify: (type: TelegramNotificationType) => void;
}

/** Haptic feedback when the Telegram client supports it; silent no-ops otherwise. */
export function useHaptics(): Haptics {
  const webApp = useWebApp();
  const impact = useCallback(
    (style: TelegramImpactStyle = 'light') => {
      try {
        webApp?.HapticFeedback?.impactOccurred(style);
      } catch {
        // Haptics are a nicety; never let them break a flow.
      }
    },
    [webApp],
  );
  const notify = useCallback(
    (type: TelegramNotificationType) => {
      try {
        webApp?.HapticFeedback?.notificationOccurred(type);
      } catch {
        // See above.
      }
    },
    [webApp],
  );
  return { impact, notify };
}
