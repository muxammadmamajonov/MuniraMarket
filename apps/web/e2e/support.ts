import { expect, type Page } from '@playwright/test';

/**
 * Shared helpers for the storefront E2E specs.
 *
 * Authentication goes through the real Mini App path: `telegram-web-app.js` is replaced with a
 * stub whose `initData` is HMAC-signed with E2E_TELEGRAM_BOT_TOKEN (see `telegram-init-data.ts`),
 * and the app posts it to the Core API exactly as inside Telegram. Every other telegram.org
 * request is blocked.
 */

const WEB_APP_SCRIPT = 'https://telegram.org/js/telegram-web-app.js';

export function requireBotToken(): string {
  const token = process.env['E2E_TELEGRAM_BOT_TOKEN'];
  if (token === undefined || token === '') {
    throw new Error(
      'Set E2E_TELEGRAM_BOT_TOKEN to the (test-only) bot token the Core API under test uses.',
    );
  }
  return token;
}

/** State of the stubbed native MainButton, readable from the test. */
export interface MainButtonState {
  text: string;
  visible: boolean;
  disabled: boolean;
  progress: boolean;
}

/**
 * `window.Telegram.WebApp` stub. The MainButton is stateful (text, visibility, disabled and
 * progress are recorded on `window.__mm`) and `window.__mm.pressMain()` behaves like a tap: it does
 * nothing while the button is hidden or disabled. Other UI methods are no-ops with real handler
 * registries.
 */
function webAppStub(initData: string): string {
  return `
(() => {
  const noop = () => {};
  const registry = (extra = {}) => {
    const handlers = new Set();
    return {
      onClick: (cb) => handlers.add(cb),
      offClick: (cb) => handlers.delete(cb),
      show: noop, hide: noop, enable: noop, disable: noop,
      showProgress: noop, hideProgress: noop, setText: noop,
      isVisible: false, isActive: true, text: '',
      __handlers: handlers,
      ...extra,
    };
  };
  const main = { text: '', visible: false, disabled: false, progress: false };
  const mainHandlers = new Set();
  const mainButton = {
    onClick: (cb) => mainHandlers.add(cb),
    offClick: (cb) => mainHandlers.delete(cb),
    setText: (text) => { main.text = text; },
    show: () => { main.visible = true; },
    hide: () => { main.visible = false; },
    enable: () => { main.disabled = false; },
    disable: () => { main.disabled = true; },
    showProgress: () => { main.progress = true; },
    hideProgress: () => { main.progress = false; },
    isVisible: false, isActive: true, text: '',
  };
  window.__mm = {
    main,
    pressMain: () => {
      if (!main.visible || main.disabled) return false;
      for (const handler of [...mainHandlers]) handler();
      return true;
    },
  };
  const events = new Map();
  window.Telegram = {
    WebApp: {
      initData: ${JSON.stringify(initData)},
      // Deliberately unsigned/untrusted, as in real life: the app must never send it anywhere.
      initDataUnsafe: { user: { id: 900000001, first_name: 'E2E' } },
      colorScheme: 'light',
      themeParams: {},
      platform: 'tdesktop',
      version: '8.0',
      ready: noop,
      expand: noop,
      onEvent: (type, cb) => { (events.get(type) ?? events.set(type, new Set()).get(type)).add(cb); },
      offEvent: (type, cb) => { events.get(type)?.delete(cb); },
      BackButton: registry(),
      MainButton: mainButton,
      HapticFeedback: { impactOccurred: noop, notificationOccurred: noop, selectionChanged: noop },
    },
  };
})();
`;
}

export async function installTelegramStub(page: Page, initData: string): Promise<void> {
  // Routes registered later win, so block everything first, then allow the stub.
  await page.route(/^https:\/\/([^/]+\.)?telegram\.org\//, (route) => route.abort());
  await page.route(WEB_APP_SCRIPT, (route) =>
    route.fulfill({ contentType: 'application/javascript', body: webAppStub(initData) }),
  );
}

/** The stubbed MainButton as the page currently sees it. */
export function mainButton(page: Page): Promise<MainButtonState> {
  return page.evaluate(() => ({
    ...(window as unknown as { __mm: { main: MainButtonState } }).__mm.main,
  }));
}

/** Taps the stubbed MainButton; `false` when it is hidden or disabled (a real tap would do nothing). */
export function pressMainButton(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    (window as unknown as { __mm: { pressMain: () => boolean } }).__mm.pressMain(),
  );
}

/** Records CSP violations in the page so the test can assert there were none. */
export async function trackCspViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const store: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = store;
    document.addEventListener('securitypolicyviolation', (event) => {
      store.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return () => page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
}

/** The storefront's uz price format: thousands grouped and suffixed with U+00A0, `so‘m`. */
export function uzs(amount: number): string {
  return `${String(amount).replace(/\B(?=(\d{3})+$)/g, ' ')} so‘m`;
}

export const CART_EMPTY = 'Savatingiz bo‘sh';

/**
 * Removes every line from the cart through the UI. The E2E user is the same on every run, so a
 * cart left behind by an earlier (failed) run must not change what a test asserts.
 */
export async function emptyCart(page: Page): Promise<void> {
  await page.goto('/uz/cart');
  const lines = page.getByTestId('cart-line');
  await expect(lines.first().or(page.getByText(CART_EMPTY))).toBeVisible({ timeout: 15_000 });
  for (let remaining = await lines.count(); remaining > 0; remaining -= 1) {
    await lines
      .first()
      .getByRole('button', { name: /^O‘chirish/ })
      .click();
    await expect(lines).toHaveCount(remaining - 1);
  }
  await expect(page.getByText(CART_EMPTY)).toBeVisible();
}
