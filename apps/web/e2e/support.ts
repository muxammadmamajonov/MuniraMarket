import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { buildSignedLoginWidgetFields } from './telegram-login-widget';

/**
 * Shared helpers for the storefront E2E specs.
 *
 * Authentication goes through the real Mini App path: `telegram-web-app.js` is replaced with a
 * stub whose `initData` is HMAC-signed with E2E_TELEGRAM_BOT_TOKEN (see `telegram-init-data.ts`),
 * and the app posts it to the Core API exactly as inside Telegram. Every other telegram.org
 * request is blocked.
 *
 * The admin app signs in through the real Telegram Login Widget redirect flow instead; see
 * `signInToAdmin` below.
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

// --- Admin app --------------------------------------------------------------------------------

const LOGIN_WIDGET_SCRIPT = /^https:\/\/telegram\.org\/js\/telegram-widget\.js(\?.*)?$/;

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

/**
 * Stand-in for `https://telegram.org/js/telegram-widget.js`. The real script is injected by the
 * admin's own `TelegramLoginButton` with `data-auth-url` (carrying the one-time `state` the app
 * stored in this tab's sessionStorage); it renders a button in an iframe and, once the user
 * authorises, sends the browser to `data-auth-url` with the signed fields appended. The stub does
 * the same with a plain button, so the app itself issues the state, the callback page verifies it
 * and posts the fields to the Core API, which checks the HMAC. Nothing in production code knows
 * about the test.
 */
function loginWidgetStub(fields: Record<string, string>): string {
  return `
(() => {
  const script = document.currentScript;
  const authUrl = script?.getAttribute('data-auth-url');
  const host = script?.parentElement;
  if (!authUrl || !host) throw new Error('Login Widget stub: missing data-auth-url or container');
  const fields = ${JSON.stringify(fields)};
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Log in with Telegram';
  button.setAttribute('data-testid', 'telegram-login-stub');
  button.addEventListener('click', () => {
    const url = new URL(authUrl);
    for (const [key, value] of Object.entries(fields)) url.searchParams.append(key, value);
    window.location.assign(url.toString());
  });
  host.appendChild(button);
})();
`;
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
 * Signs in to the admin app through the Telegram Login Widget redirect flow: the widget script is
 * answered by `loginWidgetStub` with fields signed (fresh `auth_date`) by `E2E_TELEGRAM_BOT_TOKEN`,
 * every other telegram.org request is blocked, and the "login" button is clicked like a user's.
 * Resolves once the staff navigation is visible.
 */
export async function signInToAdmin(page: Page): Promise<void> {
  const botToken = requireBotToken();
  const adminId = requireAdminTelegramId();

  // Routes registered later win, so block everything first, then answer the widget script.
  await page.route(/^https:\/\/([^/]+\.)?telegram\.org\//, (route) => route.abort());
  await page.route(LOGIN_WIDGET_SCRIPT, (route) => {
    const fields = buildSignedLoginWidgetFields({
      botToken,
      user: { id: adminId, first_name: ADMIN_FIRST_NAME, last_name: ADMIN_LAST_NAME },
    });
    return route.fulfill({ contentType: 'application/javascript', body: loginWidgetStub(fields) });
  });

  await page.goto('/uz');
  await expect(page.getByTestId('telegram-login-widget')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('telegram-login-stub').click();
  await expect(page.getByTestId('nav-products')).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/uz\/?$/);
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
