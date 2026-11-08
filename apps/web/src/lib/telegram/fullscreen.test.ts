import { describe, expect, it, vi } from 'vitest';
import { armFullscreenOnFirstGesture, disableVerticalSwipes } from './fullscreen';
import { makeWebApp } from './test-helpers';
import type { TelegramEventHandler } from './types';

function fakeTarget() {
  const listeners = new Map<string, EventListener>();
  return {
    addEventListener: vi.fn((type: string, listener: EventListener) =>
      listeners.set(type, listener),
    ),
    removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    tap: () => listeners.get('pointerup')?.(new Event('pointerup')),
    listeners,
  };
}

describe('armFullscreenOnFirstGesture', () => {
  it('asks for fullscreen once, on the first tap, on phones', () => {
    const requestFullscreen = vi.fn();
    const webApp = makeWebApp({
      platform: 'ios',
      isVersionAtLeast: () => true,
      requestFullscreen,
    });
    const target = fakeTarget();
    armFullscreenOnFirstGesture(webApp, target as unknown as Document);
    expect(requestFullscreen).not.toHaveBeenCalled();
    target.tap();
    target.tap();
    expect(requestFullscreen).toHaveBeenCalledOnce();
  });

  it('never asks on desktop clients, old clients or when already fullscreen', () => {
    for (const overrides of [
      { platform: 'tdesktop', isVersionAtLeast: () => true },
      { platform: 'android', isVersionAtLeast: () => false },
      { platform: 'android', isVersionAtLeast: () => true, isFullscreen: true },
    ]) {
      const requestFullscreen = vi.fn();
      const target = fakeTarget();
      armFullscreenOnFirstGesture(
        makeWebApp({ ...overrides, requestFullscreen }),
        target as unknown as Document,
      );
      target.tap();
      expect(requestFullscreen).not.toHaveBeenCalled();
      expect(target.listeners.size).toBe(0);
    }
  });

  it('gives up after Telegram refuses (fallback: stays expanded)', () => {
    let failed: TelegramEventHandler | undefined;
    const requestFullscreen = vi.fn();
    const webApp = makeWebApp({
      platform: 'android',
      isVersionAtLeast: () => true,
      requestFullscreen,
      onEvent: vi.fn((type: string, handler: TelegramEventHandler) => {
        if (type === 'fullscreenFailed') failed = handler;
      }),
    });
    const target = fakeTarget();
    armFullscreenOnFirstGesture(webApp, target as unknown as Document);
    failed?.();
    target.tap();
    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it('cleans up its listeners', () => {
    const webApp = makeWebApp({
      platform: 'ios',
      isVersionAtLeast: () => true,
      requestFullscreen: vi.fn(),
    });
    const target = fakeTarget();
    const cleanup = armFullscreenOnFirstGesture(webApp, target as unknown as Document);
    cleanup();
    expect(target.removeEventListener).toHaveBeenCalled();
    expect(webApp.offEvent).toHaveBeenCalledWith('fullscreenFailed', expect.any(Function));
  });
});

describe('disableVerticalSwipes', () => {
  it('uses the API only where it exists', () => {
    const disable = vi.fn();
    disableVerticalSwipes(
      makeWebApp({ isVersionAtLeast: () => true, disableVerticalSwipes: disable }),
    );
    expect(disable).toHaveBeenCalledOnce();
    expect(() => disableVerticalSwipes(makeWebApp())).not.toThrow();
    expect(() => disableVerticalSwipes(null)).not.toThrow();
  });
});
