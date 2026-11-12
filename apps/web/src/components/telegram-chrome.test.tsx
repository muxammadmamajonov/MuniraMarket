import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import { registerParent } from '@/lib/back-navigation';
import { TelegramProvider } from '@/lib/telegram';
import { installWebApp, makeWebApp, uninstallWebApp } from '@/lib/telegram/test-helpers';
import { TelegramChrome } from './telegram-chrome';

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
  nav.pathname = '/uz/orders';
  nav.back.mockReset();
  nav.push.mockReset();
  nav.replace.mockReset();
});

afterEach(() => {
  uninstallWebApp();
  vi.restoreAllMocks();
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

  it('shows the BackButton on a page below a tab and goes back in history', () => {
    nav.pathname = '/uz/c/fruits';
    const webApp = makeWebApp();
    installWebApp(webApp);
    vi.spyOn(window.history, 'length', 'get').mockReturnValue(3);
    renderChrome();

    expect(webApp.BackButton.show).toHaveBeenCalled();
    vi.mocked(webApp.BackButton.onClick).mock.calls[0]?.[0]();
    expect(nav.back).toHaveBeenCalledOnce();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('replaces a deep-linked page with its logical parent when there is no history', () => {
    nav.pathname = '/uz/c/fruits';
    const webApp = makeWebApp();
    installWebApp(webApp);
    vi.spyOn(window.history, 'length', 'get').mockReturnValue(1);
    renderChrome();
    vi.mocked(webApp.BackButton.onClick).mock.calls[0]?.[0]();
    expect(nav.replace).toHaveBeenCalledWith('/uz/catalog');
    expect(nav.back).not.toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("uses the parent a page registered (a product's category)", () => {
    nav.pathname = '/uz/p/olma';
    const webApp = makeWebApp();
    installWebApp(webApp);
    vi.spyOn(window.history, 'length', 'get').mockReturnValue(1);
    const unregister = registerParent('/uz/p/olma', '/uz/c/fruits');
    renderChrome();
    vi.mocked(webApp.BackButton.onClick).mock.calls[0]?.[0]();
    expect(nav.replace).toHaveBeenCalledWith('/uz/c/fruits');
    unregister();
  });

  it('trusts the Navigation API over history.length: index 0 means a fresh deep link', () => {
    nav.pathname = '/uz/orders';
    const webApp = makeWebApp();
    installWebApp(webApp);
    vi.spyOn(window.history, 'length', 'get').mockReturnValue(4);
    Object.defineProperty(window, 'navigation', {
      configurable: true,
      value: { currentEntry: { index: 0 } },
    });
    try {
      renderChrome();
      vi.mocked(webApp.BackButton.onClick).mock.calls[0]?.[0]();
      expect(nav.replace).toHaveBeenCalledWith('/uz/profile');
      expect(nav.back).not.toHaveBeenCalled();
    } finally {
      delete (window as { navigation?: unknown }).navigation;
    }
  });

  it.each(['/uz', '/uz/catalog', '/ru/cart', '/uz/profile'])(
    'does not show the BackButton on the tab root %s',
    (pathname) => {
      nav.pathname = pathname;
      const webApp = makeWebApp();
      installWebApp(webApp);
      renderChrome();
      expect(webApp.BackButton.show).not.toHaveBeenCalled();
      expect(webApp.BackButton.onClick).not.toHaveBeenCalled();
    },
  );

  it('keeps one listener while moving between two inner pages, and swaps it off at a tab root', () => {
    nav.pathname = '/uz/c/fruits';
    const webApp = makeWebApp();
    installWebApp(webApp);
    const view = renderChrome();
    nav.pathname = '/uz/p/olma';
    view.rerender(
      <LocaleProvider locale="uz">
        <TelegramProvider>
          <TelegramChrome />
        </TelegramProvider>
      </LocaleProvider>,
    );
    expect(webApp.BackButton.onClick).toHaveBeenCalledOnce();
    expect(webApp.BackButton.hide).not.toHaveBeenCalled();
    nav.pathname = '/uz/catalog';
    view.rerender(
      <LocaleProvider locale="uz">
        <TelegramProvider>
          <TelegramChrome />
        </TelegramProvider>
      </LocaleProvider>,
    );
    expect(webApp.BackButton.offClick).toHaveBeenCalledOnce();
    expect(webApp.BackButton.hide).toHaveBeenCalledOnce();
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
