import type { TelegramWebApp } from './types';

/**
 * Telegram fullscreen, used only by the map picker and only after the customer pressed a button
 * that opens it. Fullscreen is a request: the client may refuse (`fullscreenFailed`), be too old,
 * or be a desktop client that ignores it. Callers never wait for it and the layout never depends
 * on it: the safe-area variables (see `safe-area.ts`) follow whatever actually happened.
 */

export function canRequestFullscreen(webApp: TelegramWebApp | null): webApp is TelegramWebApp {
  if (webApp === null || typeof webApp.requestFullscreen !== 'function') return false;
  try {
    return webApp.isVersionAtLeast?.('8.0') ?? false;
  } catch {
    return false;
  }
}

/**
 * Asks for fullscreen when supported and not already on. Returns `true` only when a request was
 * sent, so the caller knows whether it should exit fullscreen again afterwards.
 */
export function requestFullscreenOnce(webApp: TelegramWebApp | null): boolean {
  if (!canRequestFullscreen(webApp) || webApp.isFullscreen === true) return false;
  try {
    webApp.requestFullscreen?.();
    return true;
  } catch {
    return false;
  }
}

/** Leaves fullscreen if it is on. Safe to call when the request was refused. */
export function exitFullscreenIfOn(webApp: TelegramWebApp | null): void {
  if (webApp === null || webApp.isFullscreen !== true) return;
  try {
    webApp.exitFullscreen?.();
  } catch {
    // Nothing to undo: the client keeps whatever mode it is in.
  }
}
