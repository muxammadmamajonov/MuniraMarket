'use client';

import { useEffect } from 'react';
import { useTelegram } from './provider';
import type { TelegramEventHandler, TelegramInsets, TelegramWebApp } from './types';

/**
 * Telegram's safe areas, mirrored onto CSS variables on `<html>`:
 *
 * - `--mm-tg-safe-{top,bottom,left,right}`: the device inset Telegram reports (`safeAreaInset`);
 * - `--mm-tg-content-{top,bottom,left,right}`: the part Telegram's own controls cover
 *   (`contentSafeAreaInset`, e.g. the Close / "…" row in fullscreen).
 *
 * `globals.css` combines them with the browser's `env(safe-area-inset-*)` into the
 * `--mm-inset-*` variables that every fixed or sticky element pads by, so the same layout works
 * in a browser, in the Mini App and in Telegram fullscreen, in portrait and landscape. Nothing
 * here sniffs the platform: missing fields (older clients, plain browsers) simply mean 0.
 */

const SIDES = ['top', 'bottom', 'left', 'right'] as const;

const EVENTS = [
  'safeAreaChanged',
  'contentSafeAreaChanged',
  'fullscreenChanged',
  'viewportChanged',
] as const;

function px(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? `${String(Math.round(value))}px`
    : '0px';
}

/** Writes the current insets (and the fullscreen flag) to `root`. Exported for tests. */
export function applySafeAreaInsets(root: HTMLElement, webApp: TelegramWebApp): void {
  const safe: Partial<TelegramInsets> = webApp.safeAreaInset ?? {};
  const content: Partial<TelegramInsets> = webApp.contentSafeAreaInset ?? {};
  for (const side of SIDES) {
    root.style.setProperty(`--mm-tg-safe-${side}`, px(safe[side]));
    root.style.setProperty(`--mm-tg-content-${side}`, px(content[side]));
  }
  if (webApp.isFullscreen === true) root.dataset['tgFullscreen'] = '';
  else delete root.dataset['tgFullscreen'];
}

/** Removes everything `applySafeAreaInsets` wrote. */
export function clearSafeAreaInsets(root: HTMLElement): void {
  for (const side of SIDES) {
    root.style.removeProperty(`--mm-tg-safe-${side}`);
    root.style.removeProperty(`--mm-tg-content-${side}`);
  }
  delete root.dataset['tgFullscreen'];
}

/** Keeps the CSS variables in step with Telegram's change events. No-op in a browser. */
export function useTelegramSafeArea(): void {
  const telegram = useTelegram();
  const webApp = telegram.kind === 'telegram' ? telegram.webApp : null;

  useEffect(() => {
    if (webApp === null) return undefined;
    const root = document.documentElement;
    const update: TelegramEventHandler = () => applySafeAreaInsets(root, webApp);
    update();
    for (const event of EVENTS) webApp.onEvent(event, update);
    return () => {
      for (const event of EVENTS) webApp.offEvent(event, update);
      clearSafeAreaInsets(root);
    };
  }, [webApp]);
}
