'use client';

import { useEffect } from 'react';

/** WebKit's pinch events (iOS Safari and WKWebView, so also Telegram on iOS). */
const PINCH_EVENTS = ['gesturestart', 'gesturechange', 'gestureend'] as const;

function preventDefault(event: Event): void {
  event.preventDefault();
}

/**
 * Blocks pinch zoom where the viewport's `user-scalable=no` is not honoured (iOS WebKit ignores
 * it). Double-tap zoom is turned off by `touch-action: pan-x pan-y` in globals.css, which keeps
 * native scrolling. Deliberately no `touchmove` or `wheel` listener: a non-passive one of those
 * makes the browser wait for JavaScript before every scroll frame. The map sets its own
 * `touch-action` and handles its pinch in JavaScript, so it still zooms. Renders nothing.
 */
export function ZoomGuard() {
  useEffect(() => {
    for (const type of PINCH_EVENTS) {
      document.addEventListener(type, preventDefault, { passive: false });
    }
    return () => {
      for (const type of PINCH_EVENTS) document.removeEventListener(type, preventDefault);
    };
  }, []);
  return null;
}
