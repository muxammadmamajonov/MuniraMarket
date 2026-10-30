import { render, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramProvider, useBackButton, useHaptics, useMainButton } from '.';
import { applyTelegramTheme, useTelegramTheme } from './theme';
import { installWebApp, makeWebApp, uninstallWebApp } from './test-helpers';

function wrapper({ children }: { children: ReactNode }) {
  return <TelegramProvider>{children}</TelegramProvider>;
}

afterEach(() => {
  uninstallWebApp();
});

describe('useBackButton', () => {
  it('shows the button and registers a click handler', () => {
    const webApp = makeWebApp();
    installWebApp(webApp);
    const onClick = vi.fn();
    renderHook(() => useBackButton({ visible: true, onClick }), { wrapper });

    expect(webApp.BackButton.show).toHaveBeenCalledOnce();
    expect(webApp.BackButton.onClick).toHaveBeenCalledOnce();
    const handler = vi.mocked(webApp.BackButton.onClick).mock.calls[0]?.[0];
    handler?.();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('calls the latest onClick without re-registering', () => {
    const webApp = makeWebApp();
    installWebApp(webApp);
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useBackButton({ visible: true, onClick: cb }), {
      wrapper,
      initialProps: { cb: first },
    });
    rerender({ cb: second });
    vi.mocked(webApp.BackButton.onClick).mock.calls[0]?.[0]();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(webApp.BackButton.onClick).toHaveBeenCalledOnce();
  });

  it('removes the same handler and hides the button on unmount', () => {
    const webApp = makeWebApp();
    installWebApp(webApp);
    const { unmount } = renderHook(() => useBackButton({ visible: true, onClick: vi.fn() }), {
      wrapper,
    });
    const registered = vi.mocked(webApp.BackButton.onClick).mock.calls[0]?.[0];
    unmount();
    expect(webApp.BackButton.offClick).toHaveBeenCalledWith(registered);
    expect(webApp.BackButton.hide).toHaveBeenCalled();
  });

  it('does nothing while not visible', () => {
    const webApp = makeWebApp();
    installWebApp(webApp);
    renderHook(() => useBackButton({ visible: false, onClick: vi.fn() }), { wrapper });
    expect(webApp.BackButton.show).not.toHaveBeenCalled();
    expect(webApp.BackButton.onClick).not.toHaveBeenCalled();
  });

  it('is a no-op outside Telegram', () => {
    expect(() =>
      renderHook(() => useBackButton({ visible: true, onClick: vi.fn() }), { wrapper }),
    ).not.toThrow();
  });
});

describe('useMainButton', () => {
  const config = { text: 'Add to cart', onClick: vi.fn() };

  it('sets the text, shows the button and registers the click handler', () => {
    const webApp = makeWebApp();
    installWebApp(webApp);
    const onClick = vi.fn();
    renderHook(() => useMainButton({ ...config, onClick }), { wrapper });

    expect(webApp.MainButton.setText).toHaveBeenCalledWith('Add to cart');
    expect(webApp.MainButton.show).toHaveBeenCalledOnce();
    expect(webApp.MainButton.enable).toHaveBeenCalled();
    vi.mocked(webApp.MainButton.onClick).mock.calls[0]?.[0]();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('updates text, disabled and progress state', () => {
    const webApp = makeWebApp();
    installWebApp(webApp);
    const { rerender } = renderHook((props) => useMainButton(props), {
      wrapper,
      initialProps: { ...config } as Parameters<typeof useMainButton>[0],
    });
    rerender({ ...config, text: 'Adding', disabled: true, loading: true });
    expect(webApp.MainButton.setText).toHaveBeenLastCalledWith('Adding');
    expect(webApp.MainButton.disable).toHaveBeenCalled();
    expect(webApp.MainButton.showProgress).toHaveBeenCalledWith(false);
    // Still a single registered listener.
    expect(webApp.MainButton.onClick).toHaveBeenCalledOnce();
  });

  it('removes the listener and hides the button on unmount', () => {
    const webApp = makeWebApp();
    installWebApp(webApp);
    const { unmount } = renderHook(() => useMainButton(config), { wrapper });
    const registered = vi.mocked(webApp.MainButton.onClick).mock.calls[0]?.[0];
    unmount();
    expect(webApp.MainButton.offClick).toHaveBeenCalledWith(registered);
    expect(webApp.MainButton.hide).toHaveBeenCalled();
  });

  it('hides the button when the config becomes null', () => {
    const webApp = makeWebApp();
    installWebApp(webApp);
    const { rerender } = renderHook((props) => useMainButton(props), {
      wrapper,
      initialProps: config as Parameters<typeof useMainButton>[0],
    });
    rerender(null);
    expect(webApp.MainButton.offClick).toHaveBeenCalledOnce();
    expect(webApp.MainButton.hide).toHaveBeenCalled();
  });

  it('never touches the button for a null config', () => {
    const webApp = makeWebApp();
    installWebApp(webApp);
    renderHook(() => useMainButton(null), { wrapper });
    expect(webApp.MainButton.show).not.toHaveBeenCalled();
    expect(webApp.MainButton.onClick).not.toHaveBeenCalled();
  });
});

describe('useHaptics', () => {
  it('forwards to HapticFeedback when available', () => {
    const haptic = {
      impactOccurred: vi.fn(),
      notificationOccurred: vi.fn(),
      selectionChanged: vi.fn(),
    };
    installWebApp(makeWebApp({ HapticFeedback: haptic }));
    const { result } = renderHook(() => useHaptics(), { wrapper });
    result.current.notify('success');
    result.current.impact('medium');
    expect(haptic.notificationOccurred).toHaveBeenCalledWith('success');
    expect(haptic.impactOccurred).toHaveBeenCalledWith('medium');
  });

  it('is silent without HapticFeedback or outside Telegram', () => {
    installWebApp(makeWebApp());
    const inTelegram = renderHook(() => useHaptics(), { wrapper });
    expect(() => inTelegram.result.current.notify('success')).not.toThrow();
    uninstallWebApp();
    const browser = renderHook(() => useHaptics(), { wrapper });
    expect(() => browser.result.current.impact()).not.toThrow();
  });
});

describe('Telegram theme', () => {
  it('maps well-formed theme colours to design tokens and undoes them', () => {
    const root = document.createElement('div');
    const undo = applyTelegramTheme(
      { bg_color: '#112233', text_color: 'red', button_color: '#abcdef' },
      root,
    );
    expect(root.style.getPropertyValue('--mm-color-background')).toBe('#112233');
    expect(root.style.getPropertyValue('--mm-color-primary')).toBe('#abcdef');
    expect(root.style.getPropertyValue('--mm-color-foreground')).toBe('');
    undo();
    expect(root.style.getPropertyValue('--mm-color-background')).toBe('');
  });

  it('applies on mount, follows themeChanged and cleans up', () => {
    const webApp = makeWebApp({ themeParams: { bg_color: '#010203' } });
    installWebApp(webApp);
    function Theme() {
      useTelegramTheme();
      return null;
    }
    const { unmount } = render(
      <TelegramProvider>
        <Theme />
      </TelegramProvider>,
    );
    expect(document.documentElement.style.getPropertyValue('--mm-color-background')).toBe(
      '#010203',
    );
    expect(webApp.onEvent).toHaveBeenCalledWith('themeChanged', expect.any(Function));
    unmount();
    expect(document.documentElement.style.getPropertyValue('--mm-color-background')).toBe('');
    expect(webApp.offEvent).toHaveBeenCalledWith('themeChanged', expect.any(Function));
  });
});
