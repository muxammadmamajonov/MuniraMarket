import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMainButton, useSuppressMainButton } from './hooks';
import { TelegramProvider } from './provider';
import { applySafeAreaInsets, useTelegramSafeArea } from './safe-area';
import { installWebApp, makeWebApp, uninstallWebApp } from './test-helpers';
import type { TelegramEventHandler, TelegramEventType, TelegramWebApp } from './types';

const root = () => document.documentElement;
const value = (name: string) => root().style.getPropertyValue(name);

/** A WebApp whose `onEvent` handlers can be fired from the test. */
function eventfulWebApp(overrides: Partial<TelegramWebApp> = {}) {
  const handlers = new Map<TelegramEventType, Set<TelegramEventHandler>>();
  const webApp = makeWebApp({
    onEvent: vi.fn((type: TelegramEventType, handler: TelegramEventHandler) => {
      const set = handlers.get(type) ?? new Set();
      set.add(handler);
      handlers.set(type, set);
    }),
    offEvent: vi.fn((type: TelegramEventType, handler: TelegramEventHandler) => {
      handlers.get(type)?.delete(handler);
    }),
    ...overrides,
  });
  const fire = (type: TelegramEventType) => {
    for (const handler of handlers.get(type) ?? []) handler();
  };
  return { webApp, fire, handlers };
}

function SafeArea() {
  useTelegramSafeArea();
  return null;
}

function mount(webApp: TelegramWebApp | null) {
  if (webApp !== null) installWebApp(webApp);
  return render(
    <TelegramProvider>
      <SafeArea />
    </TelegramProvider>,
  );
}

afterEach(() => {
  uninstallWebApp();
  root().removeAttribute('style');
  delete root().dataset['tgFullscreen'];
});

describe('Telegram safe areas', () => {
  it('in a plain browser writes nothing (CSS falls back to env())', () => {
    mount(null);
    expect(value('--mm-tg-safe-top')).toBe('');
  });

  it('normal (non-fullscreen) Mini App: zero insets', () => {
    mount(
      makeWebApp({
        safeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 },
        contentSafeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 },
        isFullscreen: false,
      }),
    );
    expect(value('--mm-tg-safe-top')).toBe('0px');
    expect(value('--mm-tg-content-top')).toBe('0px');
    expect(root().dataset['tgFullscreen']).toBeUndefined();
  });

  it('fullscreen portrait: status bar plus Telegram controls on top, home area at the bottom', () => {
    mount(
      makeWebApp({
        safeAreaInset: { top: 47, bottom: 34, left: 0, right: 0 },
        contentSafeAreaInset: { top: 46, bottom: 0, left: 0, right: 0 },
        isFullscreen: true,
      }),
    );
    expect(value('--mm-tg-safe-top')).toBe('47px');
    expect(value('--mm-tg-content-top')).toBe('46px');
    expect(value('--mm-tg-safe-bottom')).toBe('34px');
    expect(root().dataset['tgFullscreen']).toBe('');
  });

  it('fullscreen landscape: side insets', () => {
    mount(
      makeWebApp({
        safeAreaInset: { top: 0, bottom: 21, left: 59, right: 59 },
        contentSafeAreaInset: { top: 38, bottom: 0, left: 0, right: 0 },
        isFullscreen: true,
      }),
    );
    expect(value('--mm-tg-safe-left')).toBe('59px');
    expect(value('--mm-tg-safe-right')).toBe('59px');
    expect(value('--mm-tg-content-top')).toBe('38px');
  });

  it('follows safe-area and fullscreen change events, and cleans up on unmount', () => {
    const { webApp, fire, handlers } = eventfulWebApp({
      safeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 },
      contentSafeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 },
      isFullscreen: false,
    });
    const view = mount(webApp);
    expect(value('--mm-tg-content-top')).toBe('0px');

    Object.assign(webApp, {
      safeAreaInset: { top: 47, bottom: 34, left: 0, right: 0 },
      contentSafeAreaInset: { top: 46, bottom: 0, left: 0, right: 0 },
      isFullscreen: true,
    });
    act(() => fire('fullscreenChanged'));
    expect(value('--mm-tg-safe-top')).toBe('47px');
    expect(root().dataset['tgFullscreen']).toBe('');

    Object.assign(webApp, { safeAreaInset: { top: 0, bottom: 21, left: 59, right: 59 } });
    act(() => fire('safeAreaChanged'));
    expect(value('--mm-tg-safe-left')).toBe('59px');

    Object.assign(webApp, { contentSafeAreaInset: { top: 38, bottom: 0, left: 0, right: 0 } });
    act(() => fire('contentSafeAreaChanged'));
    expect(value('--mm-tg-content-top')).toBe('38px');

    view.unmount();
    expect(value('--mm-tg-safe-left')).toBe('');
    expect(root().dataset['tgFullscreen']).toBeUndefined();
    for (const set of handlers.values()) expect(set.size).toBe(0);
  });

  it('older clients without the 8.0 fields, or garbage values, count as 0', () => {
    const webApp = makeWebApp();
    applySafeAreaInsets(root(), webApp);
    expect(value('--mm-tg-safe-bottom')).toBe('0px');
    applySafeAreaInsets(
      root(),
      makeWebApp({
        safeAreaInset: { top: Number.NaN, bottom: -5, left: Infinity, right: 3.6 },
      }),
    );
    expect(value('--mm-tg-safe-top')).toBe('0px');
    expect(value('--mm-tg-safe-bottom')).toBe('0px');
    expect(value('--mm-tg-safe-left')).toBe('0px');
    expect(value('--mm-tg-safe-right')).toBe('4px');
  });
});

describe('useSuppressMainButton', () => {
  function Page() {
    const [overlay, setOverlay] = useState(false);
    useMainButton({ text: 'Savatga o‘tish', onClick: () => undefined });
    return (
      <>
        <Overlay active={overlay} />
        <button onClick={() => setOverlay((v) => !v)}>toggle</button>
      </>
    );
  }
  function Overlay({ active }: { active: boolean }) {
    useSuppressMainButton(active);
    return null;
  }

  it('hides the MainButton while a full-screen flow is open and shows it again after', () => {
    const webApp = makeWebApp();
    installWebApp(webApp);
    const view = render(
      <TelegramProvider>
        <Page />
      </TelegramProvider>,
    );
    expect(webApp.MainButton.show).toHaveBeenCalledTimes(1);
    act(() => view.getByText('toggle').click());
    expect(webApp.MainButton.hide).toHaveBeenCalled();
    expect(webApp.MainButton.offClick).toHaveBeenCalled();
    act(() => view.getByText('toggle').click());
    expect(webApp.MainButton.show).toHaveBeenCalledTimes(2);
  });
});
