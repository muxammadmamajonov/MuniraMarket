import { botReceivesOwnContact, demoPhoneFor } from './bot';
import type { FakeTelegramUser } from './telegram-init-data';
import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
} from '@playwright/test';

/**
 * Shared helpers for the storefront E2E specs.
 *
 * Authentication goes through the real Mini App path: `telegram-web-app.js` is replaced with a
 * stub whose `initData` is HMAC-signed with E2E_TELEGRAM_BOT_TOKEN (see `telegram-init-data.ts`),
 * and the app posts it to the Core API exactly as inside Telegram. Every other telegram.org
 * request is blocked.
 *
 * The admin app signs in through the real "Sign in with Telegram" OIDC redirect flow instead,
 * against a local fake provider (`fake-telegram-oidc.ts`); see `signInToAdmin` below.
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
export interface TelegramStubOptions {
  /** Telegram client platform; phones (`ios`, `android`) arm fullscreen on the first tap. */
  platform?: string;
  /** `ok`: requestFullscreen enters fullscreen; `fail`: fires fullscreenFailed; `absent`: no API. */
  fullscreen?: 'ok' | 'fail' | 'absent';
  /**
   * Before the test, the bot stand-in verifies this user's phone (as if they had shared their
   * contact once), because placing an order needs it. Default `true`; the phone spec turns it off.
   */
  verifiedPhone?: boolean;
}

function webAppStub(initData: string, options: TelegramStubOptions = {}): string {
  const platform = options.platform ?? 'tdesktop';
  const fullscreen = options.fullscreen ?? 'absent';
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
      platform: ${JSON.stringify(platform)},
      version: '8.0',
      isVersionAtLeast: (v) => Number(v) <= 8,
      ready: noop,
      expand: noop,
      disableVerticalSwipes: noop,
      isFullscreen: false,
      ...(${JSON.stringify(fullscreen)} === 'absent' ? {} : {
        requestFullscreen() {
          window.__mm.fullscreenRequests = (window.__mm.fullscreenRequests ?? 0) + 1;
          if (${JSON.stringify(fullscreen)} === 'ok') {
            window.Telegram.WebApp.isFullscreen = true;
            window.Telegram.WebApp.safeAreaInset = { top: 47, bottom: 34, left: 0, right: 0 };
            window.Telegram.WebApp.contentSafeAreaInset = { top: 46, bottom: 0, left: 0, right: 0 };
            for (const cb of events.get('fullscreenChanged') ?? []) cb();
          } else {
            for (const cb of events.get('fullscreenFailed') ?? []) cb({ error: 'UNSUPPORTED' });
          }
        },
        exitFullscreen() {
          window.Telegram.WebApp.isFullscreen = false;
          for (const cb of events.get('fullscreenChanged') ?? []) cb();
        },
      }),
      // The contact itself goes to the bot chat; the page only learns whether it was shared. The
      // test exposes \`__mmShareContact\` to play the bot's part.
      requestContact(cb) {
        window.__mm.contactRequests = (window.__mm.contactRequests ?? 0) + 1;
        const share = window.__mmShareContact ? window.__mmShareContact() : Promise.resolve(false);
        Promise.resolve(share).then((ok) => cb && cb(ok !== false));
      },
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

export async function installTelegramStub(
  page: Page,
  initData: string,
  options: TelegramStubOptions = {},
): Promise<void> {
  if (options.verifiedPhone !== false) {
    const raw = new URLSearchParams(initData).get('user');
    if (raw !== null) {
      const user = JSON.parse(raw) as FakeTelegramUser;
      await botReceivesOwnContact(user, demoPhoneFor(user));
    }
  }
  // Routes registered later win, so block everything first, then allow the stub.
  await page.route(/^https:\/\/([^/]+\.)?telegram\.org\//, (route) => route.abort());
  await page.route(WEB_APP_SCRIPT, (route) =>
    route.fulfill({ contentType: 'application/javascript', body: webAppStub(initData, options) }),
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

// --- Admin app --------------------------------------------------------------------------------

/** Base URL of the admin app (`E2E_ADMIN_URL`, default http://localhost:3001). */
export function adminBaseUrl(): string {
  const value = process.env['E2E_ADMIN_URL'];
  return value === undefined || value === '' ? 'http://localhost:3001' : value.replace(/\/+$/, '');
}

/**
 * Telegram id of the admin the run signs in as (`E2E_ADMIN_TELEGRAM_ID`). The user must already
 * have the admin role: `cd services/api && uv run python -m app.dev.set_role <id> admin --create`.
 */
export function requireAdminTelegramId(): number {
  const raw = process.env['E2E_ADMIN_TELEGRAM_ID'];
  const id = Number(raw);
  if (raw === undefined || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error(
      'Set E2E_ADMIN_TELEGRAM_ID to the Telegram id of an admin created with ' +
        '`python -m app.dev.set_role <id> admin --create` (development/test only).',
    );
  }
  return id;
}

/** The fake name shown in the admin navigation after sign-in. */
export const ADMIN_FIRST_NAME = 'E2E';
export const ADMIN_LAST_NAME = 'Admin';

/** Issuer of the fake Telegram OIDC provider the Core API under test uses (`E2E_OIDC_ISSUER`). */
export function oidcIssuer(): string {
  const value = process.env['E2E_OIDC_ISSUER'];
  return value === undefined || value === '' ? 'http://127.0.0.1:8899' : value.replace(/\/+$/, '');
}

/** A browser context for the admin app: desktop viewport, base URL `E2E_ADMIN_URL`, no storefront cookies. */
export async function newAdminContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: adminBaseUrl(),
    viewport: { width: 1280, height: 800 },
    locale: 'uz-UZ',
  });
}

/**
 * Signs in to the admin app through the real "Sign in with Telegram" flow, nothing stubbed in the
 * browser: the admin's own button asks the Core API to start (`oidc/start`), the browser navigates
 * top-level to the fake provider's `/auth` (`fake-telegram-oidc.ts`, which signs in as
 * `E2E_ADMIN_TELEGRAM_ID` and redirects straight back), the API's callback on the admin origin
 * exchanges the code server to server (PKCE + client secret), verifies the RS256 `id_token` and
 * redirects to `/uz` with the session cookie. Every telegram.org request stays blocked. Resolves
 * once the staff navigation is visible.
 */
export async function signInToAdmin(page: Page): Promise<void> {
  requireAdminTelegramId();
  const issuer = oidcIssuer();
  const visited: string[] = [];
  const onRequest = (request: Request) => {
    if (!request.isNavigationRequest()) return;
    const url = new URL(request.url());
    visited.push(`${url.origin}${url.pathname}`);
  };
  page.on('request', onRequest);

  await page.route(/^https:\/\/([^/]+\.)?telegram\.org\//, (route) => route.abort());
  await page.goto('/uz');
  const button = page.getByRole('button', { name: 'Telegram orqali kirish' });
  await expect(button).toBeVisible({ timeout: 20_000 });
  await button.click();
  await expect(page.getByTestId('nav-products')).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/uz\/?$/);
  page.off('request', onRequest);

  // The browser really went app -> provider -> the API callback on the admin origin -> app.
  expect(visited).toContain(`${issuer}/auth`);
  expect(visited).toContain(`${adminBaseUrl()}/api/v1/auth/telegram/oidc/callback`);
}

/**
 * Collects console messages the browser reports as Content Security Policy violations. Pass the
 * same array for several pages to collect them all in one list.
 */
export function trackConsoleCsp(page: Page, into: string[] = []): string[] {
  page.on('console', (message) => {
    if (/content security policy/i.test(message.text())) into.push(message.text());
  });
  return into;
}

/**
 * The write headers of the admin's same-origin API proxy for a signed-in page: the session CSRF
 * token plus the Origin the Core API checks. For test setup and cleanup that must not depend on
 * the UI; the UI is what the specs exercise.
 */
export async function adminWriteHeaders(page: Page): Promise<Record<string, string>> {
  const session = await page.request.get('/api/v1/auth/session');
  expect(session.ok()).toBe(true);
  const csrf = ((await session.json()) as { csrf_token: string }).csrf_token;
  return {
    'X-CSRF-Token': csrf,
    Origin: adminBaseUrl(),
    'content-type': 'application/json',
  };
}
