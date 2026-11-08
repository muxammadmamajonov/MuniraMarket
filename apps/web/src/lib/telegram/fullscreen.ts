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

/** Phone and tablet clients, where fullscreen gives back the space of Telegram's header. */
const MOBILE_PLATFORMS: ReadonlySet<string> = new Set(['ios', 'android', 'android_x']);

export function isMobileTelegram(webApp: TelegramWebApp | null): boolean {
  return webApp !== null && MOBILE_PLATFORMS.has(webApp.platform);
}

/**
 * App-wide fullscreen on phones, requested once, on the customer's first tap (a real user
 * gesture), never on desktop clients and never in a browser. If Telegram refuses
 * (`fullscreenFailed`: unsupported, already fullscreen) or the client predates Bot API 8.0, the
 * app simply stays in the expanded mode `expand()` already gave it; nothing waits for the answer
 * and the layout follows the real insets either way. Returns a cleanup function.
 */
export function armFullscreenOnFirstGesture(
  webApp: TelegramWebApp | null,
  target: Pick<Document, 'addEventListener' | 'removeEventListener'> = document,
): () => void {
  if (!isMobileTelegram(webApp) || !canRequestFullscreen(webApp) || webApp.isFullscreen) {
    return () => undefined;
  }
  let done = false;
  const onFailed = () => {
    done = true;
  };
  const onGesture = () => {
    if (done) return;
    done = true;
    target.removeEventListener('pointerup', onGesture, true);
    requestFullscreenOnce(webApp);
  };
  webApp.onEvent('fullscreenFailed', onFailed);
  target.addEventListener('pointerup', onGesture, true);
  return () => {
    target.removeEventListener('pointerup', onGesture, true);
    webApp.offEvent('fullscreenFailed', onFailed);
  };
}

/** Bot API 7.7+: a vertical swipe scrolls the page instead of closing the Mini App. */
export function disableVerticalSwipes(webApp: TelegramWebApp | null): void {
  if (webApp === null || typeof webApp.disableVerticalSwipes !== 'function') return;
  try {
    if (webApp.isVersionAtLeast?.('7.7') ?? false) webApp.disableVerticalSwipes();
  } catch {
    // Older clients keep the default swipe behaviour.
  }
}
