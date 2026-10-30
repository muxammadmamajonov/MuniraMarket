import { expect, test, type Page } from '@playwright/test';
import { buildSignedInitData } from './telegram-init-data';

/**
 * Smoke flow: home -> category -> product (formatted price) -> add to cart -> cart with the
 * server-computed total -> change quantity (totals follow the server) -> remove -> empty cart.
 *
 * Authentication goes through the real Mini App path: `telegram-web-app.js` is replaced with a
 * stub whose `initData` is HMAC-signed with E2E_TELEGRAM_BOT_TOKEN, and the app posts it to the
 * Core API exactly as inside Telegram. Every other telegram.org request is blocked.
 */

const WEB_APP_SCRIPT = 'https://telegram.org/js/telegram-web-app.js';

function requireBotToken(): string {
  const token = process.env['E2E_TELEGRAM_BOT_TOKEN'];
  if (token === undefined || token === '') {
    throw new Error(
      'Set E2E_TELEGRAM_BOT_TOKEN to the (test-only) bot token the Core API under test uses.',
    );
  }
  return token;
}

/** `window.Telegram.WebApp` stub: no-op UI methods with real handler registries. */
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
      MainButton: registry(),
      HapticFeedback: { impactOccurred: noop, notificationOccurred: noop, selectionChanged: noop },
    },
  };
})();
`;
}

async function installTelegramStub(page: Page, initData: string): Promise<void> {
  // Routes registered later win, so block everything first, then allow the stub.
  await page.route(/^https:\/\/([^/]+\.)?telegram\.org\//, (route) => route.abort());
  await page.route(WEB_APP_SCRIPT, (route) =>
    route.fulfill({ contentType: 'application/javascript', body: webAppStub(initData) }),
  );
}

/** Records CSP violations in the page so the test can assert there were none. */
async function trackCspViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const store: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = store;
    document.addEventListener('securitypolicyviolation', (event) => {
      store.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return () => page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
}

/** Digits of a formatted price: "12 500 so'm" -> 12500. */
function amountOf(text: string): number {
  return Number(text.replace(/\D/g, ''));
}

/** The storefront's uz price format: thousands grouped and suffixed with U+00A0, `so‘m`. */
function uzs(amount: number): string {
  return `${String(amount).replace(/\B(?=(\d{3})+$)/g, '\u00A0')}\u00A0so‘m`;
}

const CART_EMPTY = 'Savatingiz bo‘sh';

/**
 * Removes every line from the cart through the UI. The E2E user is the same on every run, so a
 * cart left behind by an earlier (failed) run must not change what this test asserts.
 */
async function emptyCart(page: Page): Promise<void> {
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

test('browse a category, add a product to the cart and see the server total', async ({ page }) => {
  const initData = buildSignedInitData({ botToken: requireBotToken() });
  await installTelegramStub(page, initData);
  const cspViolations = await trackCspViolations(page);
  const consoleCsp: string[] = [];
  page.on('console', (message) => {
    if (/content security policy/i.test(message.text())) consoleCsp.push(message.text());
  });

  await emptyCart(page);

  // Home: the category tree is rendered.
  await page.goto('/uz');
  const categoryLinks = page.locator('section nav ul a[href*="/uz/c/"]');
  await expect(categoryLinks.first()).toBeVisible();
  const categoryHrefs = await categoryLinks.evaluateAll((links) => [
    ...new Set(links.map((link) => link.getAttribute('href') ?? '')),
  ]);

  // Category: find a product that can be bought (the seed also has an out-of-stock one).
  let productHref: string | null = null;
  for (const href of categoryHrefs) {
    await page.goto(href);
    const hrefs = await page
      .getByRole('main')
      .locator('ul a[href*="/uz/p/demo-"]')
      .evaluateAll((links) => [...new Set(links.map((link) => link.getAttribute('href') ?? ''))]);
    for (const candidate of hrefs) {
      await page.goto(candidate);
      if (
        (await page.getByRole('main').getByTestId('stock-state').getAttribute('data-stock')) !==
        'out'
      ) {
        productHref = candidate;
        break;
      }
    }
    if (productHref !== null) break;
  }
  expect(productHref, 'a purchasable demo product in some category').not.toBeNull();

  // Product: details are shown and the Telegram session makes the button usable.
  await expect(page.getByRole('main').getByTestId('product-sku')).toContainText('DEMO-');
  const slug = new URL(productHref ?? '', 'http://localhost').pathname.split('/').pop() ?? '';
  const apiProduct = (await (
    await page.request.get(`/api/v1/products/${encodeURIComponent(slug)}`)
  ).json()) as { price_uzs: number; old_price_uzs: number | null };

  // The price is shown formatted in UZS and equals what the API returned (no client arithmetic).
  const price = page.getByRole('main').getByTestId('product-price');
  await expect(price).toContainText(uzs(apiProduct.price_uzs));
  if (apiProduct.old_price_uzs !== null) {
    await expect(price.locator('del')).toContainText(uzs(apiProduct.old_price_uzs));
  }
  const addButton = page.getByRole('button', { name: 'Savatga qo‘shish' });
  await expect(addButton).toBeEnabled({ timeout: 15_000 });
  const productName = await page.getByRole('heading', { level: 1 }).innerText();
  await addButton.click();
  await expect(page.getByTestId('added-message')).toBeVisible();

  // Cart: the line and a server-computed total.
  await page.getByRole('link', { name: 'Savatni ochish' }).click();
  await expect(page).toHaveURL(/\/uz\/cart$/);
  const line = page.getByTestId('cart-line').filter({ hasText: productName });
  await expect(line).toBeVisible();

  // One unit: line total, subtotal and total are exactly the server's formatted price.
  const lineTotal = line.getByTestId('line-total');
  const total = page.getByTestId('cart-total');
  await expect(lineTotal).toHaveText(uzs(apiProduct.price_uzs));
  await expect(page.getByTestId('cart-subtotal')).toHaveText(uzs(apiProduct.price_uzs));
  await expect(total).toHaveText(uzs(apiProduct.price_uzs));
  await expect(page.getByTestId('checkout-soon')).toBeVisible();

  // Two units: the server recomputes and the page shows twice the price, not a client-side sum.
  await line.getByRole('button', { name: 'Ko‘paytirish' }).click();
  await expect(line.getByRole('status')).toHaveText('2');
  await expect(lineTotal).toHaveText(uzs(2 * apiProduct.price_uzs));
  await expect(total).toHaveText(uzs(2 * apiProduct.price_uzs));
  expect(amountOf(await total.innerText())).toBe(2 * apiProduct.price_uzs);

  // Removing the only line shows the empty-cart state and no totals.
  await line.getByRole('button', { name: /^O‘chirish/ }).click();
  await expect(page.getByText(CART_EMPTY)).toBeVisible();
  await expect(page.getByTestId('cart-line')).toHaveCount(0);
  await expect(total).toHaveCount(0);

  expect(await cspViolations()).toEqual([]);
  expect(consoleCsp).toEqual([]);
});
