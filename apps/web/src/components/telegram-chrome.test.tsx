import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { TelegramProvider } from '@/lib/telegram';
import { installWebApp, makeWebApp, uninstallWebApp } from '@/lib/telegram/test-helpers';
import { TelegramChrome, isCheckoutPath, isHomePath } from './telegram-chrome';

const nav = vi.hoisted(() => ({
  pathname: '/uz/cart',
  back: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ back: nav.back, push: nav.push, replace: nav.replace }),
}));

function renderChrome() {
  return render(
    <LocaleProvider locale="uz">
      <TelegramProvider>
        <TelegramChrome />
      </TelegramProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  nav.pathname = '/uz/cart';
  nav.back.mockReset();
  nav.push.mockReset();
  nav.replace.mockReset();
});

afterEach(() => {
  uninstallWebApp();
  vi.restoreAllMocks();
});

describe('isHomePath', () => {
  it('is true only for the bare locale path', () => {
    expect(isHomePath('/uz')).toBe(true);
    expect(isHomePath('/ru')).toBe(true);
    expect(isHomePath('/uz/')).toBe(true);
    expect(isHomePath('/uz/cart')).toBe(false);
    expect(isHomePath('/uz/c/demo')).toBe(false);
  });
});

describe('isCheckoutPath', () => {
  it('is true only for the checkout page', () => {
    expect(isCheckoutPath('/uz/checkout')).toBe(true);
    expect(isCheckoutPath('/ru/checkout')).toBe(true);
    expect(isCheckoutPath('/uz/cart')).toBe(false);
    expect(isCheckoutPath('/uz/checkout/x')).toBe(false);
    expect(isCheckoutPath('/checkout')).toBe(false);
  });
});

describe('TelegramChrome', () => {
  it('sends the BackButton of the checkout page to the cart, whatever the history holds', () => {
    nav.pathname = '/uz/checkout';
    const webApp = makeWebApp();
    installWebApp(webApp);
    vi.spyOn(window.history, 'length', 'get').mockReturnValue(5);
    renderChrome();
    vi.mocked(webApp.BackButton.onClick).mock.calls[0]?.[0]();
    expect(nav.replace).toHaveBeenCalledWith('/uz/cart');
    expect(nav.back).not.toHaveBeenCalled();
  });

  it('shows the BackButton on pages other than home and goes back in history', () => {
    const webApp = makeWebApp();
    installWebApp(webApp);
    vi.spyOn(window.history, 'length', 'get').mockReturnValue(3);
    renderChrome();

    expect(webApp.BackButton.show).toHaveBeenCalled();
    vi.mocked(webApp.BackButton.onClick).mock.calls[0]?.[0]();
    expect(nav.back).toHaveBeenCalledOnce();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('goes to the localized home page when there is no history', () => {
    const webApp = makeWebApp();
    installWebApp(webApp);
    vi.spyOn(window.history, 'length', 'get').mockReturnValue(1);
    renderChrome();
    vi.mocked(webApp.BackButton.onClick).mock.calls[0]?.[0]();
    expect(nav.push).toHaveBeenCalledWith('/uz');
    expect(nav.back).not.toHaveBeenCalled();
  });

  it('does not show the BackButton on the home page', () => {
    nav.pathname = '/uz';
    const webApp = makeWebApp();
    installWebApp(webApp);
    renderChrome();
    expect(webApp.BackButton.show).not.toHaveBeenCalled();
    expect(webApp.BackButton.onClick).not.toHaveBeenCalled();
  });

  it('removes the listener and hides the BackButton on unmount', () => {
    const webApp = makeWebApp();
    installWebApp(webApp);
    const { unmount } = renderChrome();
    const handler = vi.mocked(webApp.BackButton.onClick).mock.calls[0]?.[0];
    unmount();
    expect(webApp.BackButton.offClick).toHaveBeenCalledWith(handler);
    expect(webApp.BackButton.hide).toHaveBeenCalled();
  });

  it('hides the MainButton by default', () => {
    const webApp = makeWebApp();
    installWebApp(webApp);
    renderChrome();
    expect(webApp.MainButton.hide).toHaveBeenCalled();
    expect(webApp.MainButton.show).not.toHaveBeenCalled();
  });

  it('does nothing in a regular browser', () => {
    expect(() => renderChrome()).not.toThrow();
  });
});
