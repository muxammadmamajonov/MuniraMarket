import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 9: the mobile app shell.
 *
 * - Bottom tab bar (Home, Catalog, Cart, Profile) on phones only, with real routes, the current
 *   tab marked, an accessible cart badge, and no bar on checkout.
 * - The map step of the address chooser: without a Maps key (this server) it shows its own
 *   fallback and nothing is requested from Yandex. The keyed map flow (stub SDK) is in
 *   `delivery-map.spec.ts`. CI never talks to Yandex at all.
 * - Telegram fullscreen and landscape safe areas, through a stubbed `Telegram.WebApp`.
 * - The header slot: the logo at home, the page title everywhere else (cut to fit between
 *   Telegram's Close and "…" at 320px); no in-app back control anywhere, only Telegram's native
 *   BackButton (hidden on the tab roots, history first, then the logical parent on a deep link).
 * - No pinch or double-tap zoom, native vertical overscroll.
 * - 320px, 390px, desktop, dark mode, long Uzbek/Russian labels, a huge cart count, a long
 *   profile name, offline and a keyboard-sized viewport: never a sideways scroll.
 *
 * Browsing only: nothing here signs in. Session reads are answered locally (anonymous, or a
 * placeholder signed-in user where the profile and cart badge need one), so this spec uses none
 * of the Core API's login or session-read budget, which the whole run shares.
 *
 * Set `E2E_SHOTS_DIR` to save the screenshots used in the PR description.
 */

const DISTRICT_ITEM = 'mm.delivery-district.v1';

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['E2E_SHOTS_DIR'];
  if (dir !== undefined && dir !== '') await page.screenshot({ path: `${dir}/${name}.png` });
}

/**
 * Signed out, without touching the Core API's session route: every page load reads
 * `/auth/session`, which the API limits to 60 a minute per IP, and the whole E2E run shares that
 * budget. The answer is the API's own "no session" (401).
 */
/** Waits until the map view's entrance transition (and the sheet's exit) has finished. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => null))),
  );
}

async function browseAnonymously(page: Page): Promise<void> {
  await page.route(/^https:\/\/([^/]+\.)?telegram\.org\//, (route) => route.abort());
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({ status: 401, json: { error: { code: 'not_authenticated', message: '' } } }),
  );
}

/** Every request to a Yandex host, recorded (and refused, should one ever happen). */
async function trackYandex(page: Page): Promise<string[]> {
  const seen: string[] = [];
  await page.route(/^https:\/\/([^/]+\.)?(yandex\.(ru|net|com|uz)|yastatic\.net)\//, (route) => {
    seen.push(route.request().url());
    return route.abort();
  });
  return seen;
}

/**
 * Waits until the streamed page has replaced the `loading.tsx` shell (React reveals it a moment
 * after the HTML arrives); until then the DOM briefly holds two headers.
 */
async function pageSettled(page: Page): Promise<void> {
  await expect(page.locator('main[aria-busy="true"]')).toHaveCount(0);
}

/*
 * Visible elements only: until React cleans up, a streamed segment can linger as a copy inside a
 * `<div hidden id="S:n">`, never shown but still in the DOM.
 */
function headerTitle(page: Page) {
  return page.getByTestId('header-title').filter({ visible: true });
}

function headerLogo(page: Page) {
  return page.getByTestId('header-logo').filter({ visible: true });
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `page scrolls sideways by ${String(overflow)}px`).toBeLessThanOrEqual(0);
}

function tabBar(page: Page) {
  return page.getByTestId('bottom-nav');
}

/** Placeholder signed-in session and a cart, answered at the network boundary. */
async function fakeSignedIn(
  page: Page,
  {
    firstName,
    lastName,
    units,
    language = 'uz',
  }: { firstName: string; lastName: string | null; units: number; language?: 'uz' | 'ru' },
): Promise<void> {
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      json: {
        csrf_token: 'e2e-placeholder-csrf',
        user: {
          id: '00000000-0000-4000-8000-0000000000e2',
          first_name: firstName,
          last_name: lastName,
          // The saved account language: the storefront URL follows it.
          language,
          role: 'customer',
          language_confirmed: true,
          phone_verified: true,
          telegram_user_id: 900_000_099,
          username: null,
        },
      },
    }),
  );
  const product = {
    id: '00000000-0000-4000-8000-0000000000a1',
    slug: 'demo-olma',
    sku: 'DEMO-0001',
    name_uz: 'Olma',
    name_ru: 'Яблоко',
    unit: 'kg',
    price_uzs: 12_500,
    old_price_uzs: null,
    stock_quantity: null,
    in_stock: true,
    image_url: null,
    category_id: '00000000-0000-4000-8000-0000000000c1',
  };
  await page.route('**/api/v1/cart', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            items: [{ product, quantity: units, line_total_uzs: units * 12_500, issue: null }],
            item_count: units,
            subtotal_uzs: units * 12_500,
            total_uzs: units * 12_500,
            has_issues: false,
          },
        })
      : route.continue(),
  );
}

test.describe('bottom navigation', () => {
  test.beforeEach(async ({ page }) => browseAnonymously(page));

  test('Uzbek, 390px: four real tabs, the current one marked, every page fits', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/uz');
    const bar = tabBar(page);
    await expect(bar).toBeVisible();
    await expect(bar.getByRole('link', { name: 'Bosh sahifa' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectNoHorizontalScroll(page);
    await shot(page, 'p9-uz-390-home');

    // Home: the logo in the header slot and no title.
    await pageSettled(page);
    await expect(headerLogo(page)).toBeVisible();
    await expect(headerTitle(page)).toHaveCount(0);

    await bar.getByRole('link', { name: 'Katalog' }).click();
    await expect(page).toHaveURL(/\/uz\/catalog$/);
    await pageSettled(page);
    // The title replaces the logo and is the page's only h1; no "9 ta kategoriya" under it.
    await expect(headerTitle(page)).toHaveText('Katalog');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1, name: 'Katalog' })).toBeVisible();
    await expect(headerLogo(page)).toHaveCount(0);
    await expect(page.getByText(/ta kategoriya/)).toHaveCount(0);
    const categories = page.getByTestId('catalog-category');
    await expect(categories.first()).toBeVisible();
    await expect(bar.getByRole('link', { name: 'Katalog' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectNoHorizontalScroll(page);
    await shot(page, 'p9-uz-390-catalog');

    // A category page still belongs to the Catalog tab.
    await categories.first().click();
    await expect(page).toHaveURL(/\/uz\/c\//);
    await expect(bar.getByRole('link', { name: 'Katalog' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await bar.getByRole('link', { name: 'Profil' }).click();
    await expect(page).toHaveURL(/\/uz\/profile$/);
    await expect(page.getByTestId('sign-in-screen')).toContainText('Telegram orqali kiring');
    await expectNoHorizontalScroll(page);
    await shot(page, 'p9-uz-390-profile-anonymous');

    await bar.getByRole('link', { name: 'Savat' }).click();
    await expect(page).toHaveURL(/\/uz\/cart$/);
    await expect(bar.getByTestId('bottom-nav-cart')).toHaveAttribute('aria-current', 'page');
    await expectNoHorizontalScroll(page);

    // The last content on a long page is never hidden under the bar.
    await page.goto('/uz');
    const lastTile = page.getByTestId('product-tile').filter({ visible: true }).last();
    await expect(lastTile).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect
      .poll(async () => {
        const tileBox = await lastTile.boundingBox();
        const barBox = await bar.boundingBox();
        return tileBox === null || barBox === null
          ? Infinity
          : tileBox.y + tileBox.height - barBox.y;
      })
      .toBeLessThanOrEqual(0);
  });

  test('desktop keeps the header navigation and has no tab bar', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/uz');
    await expect(tabBar(page)).toBeHidden();
    const header = page.getByRole('navigation', { name: 'Asosiy menyu' });
    await expect(header.getByRole('link', { name: 'Buyurtmalarim' })).toBeVisible();
    await expect(page.getByTestId('header-cart').filter({ visible: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, 'p9-desktop-home');
    await page.goto('/uz/catalog');
    // No tab bar on wide screens: inner pages keep a small mark linking home next to the title.
    await expect(headerTitle(page)).toHaveText('Katalog');
    await expect(page.getByTestId('header-home').filter({ visible: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, 'p9-desktop-catalog');
  });

  test('Russian at 320px: long labels fit, nothing scrolls sideways', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    for (const path of ['/ru', '/ru/catalog', '/ru/profile', '/ru/cart', '/ru/search?q=молоко']) {
      await page.goto(path);
      await expect(tabBar(page)).toBeVisible();
      await expectNoHorizontalScroll(page);
    }
    const labelsFit = await tabBar(page)
      .locator('a > span:last-child')
      .evaluateAll((labels) => labels.every((label) => label.scrollWidth <= label.clientWidth + 1));
    expect(labelsFit).toBe(true);
    await page.goto('/ru');
    await shot(page, 'p9-ru-320-home');
  });
});

test.describe('break-ui: worst realistic data', () => {
  test.beforeEach(async ({ page }) => browseAnonymously(page));

  test('a huge cart count and a very long name, Russian, 320px', async ({ page }) => {
    await fakeSignedIn(page, {
      firstName: 'Aleksandra-Wiśniewska-Kowalczyk-Abdurakhmonova',
      lastName: 'Bartholomew-Fitzgerald-Northwind-Industries-Holdings',
      units: 12_345,
      language: 'ru',
    });
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/ru/profile');
    const name = page.getByTestId('profile-name');
    await expect(name).toContainText('Aleksandra');
    // Two lines at most, never wider than the card.
    const lines = await name.evaluate(
      (element) =>
        element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight),
    );
    expect(lines).toBeLessThanOrEqual(2.05);
    await expect(page.getByTestId('bottom-nav-cart-count')).toHaveText('99+');
    await expect(page.getByTestId('bottom-nav-cart')).toHaveAccessibleName('Корзина: 12345 шт.');
    await expectNoHorizontalScroll(page);
    await shot(page, 'p9-ru-320-profile-worst-case');
  });

  test('a one-letter name and a count of exactly 1', async ({ page }) => {
    await fakeSignedIn(page, { firstName: 'J', lastName: null, units: 1 });
    await page.goto('/uz/profile');
    await expect(page.getByTestId('profile-name')).toHaveText('J');
    await expect(page.getByTestId('bottom-nav-cart')).toHaveAccessibleName('Savat: 1 ta mahsulot');
    await expectNoHorizontalScroll(page);
  });

  test('keyboard open (short viewport): the focused search field stays above the tab bar', async ({
    page,
  }) => {
    // `interactive-widget=resizes-content`: the keyboard shrinks the layout viewport to this.
    await page.setViewportSize({ width: 390, height: 360 });
    await page.goto('/uz/catalog');
    const field = page.getByRole('search').getByRole('searchbox');
    await field.focus();
    await field.fill('Qaymoqlishokoladlimuzqaymoqlar');
    const fieldBox = await field.boundingBox();
    const barBox = await tabBar(page).boundingBox();
    expect(fieldBox && barBox && fieldBox.y + fieldBox.height <= barBox.y).toBe(true);
    // 16px text on touch: iOS never zooms into it.
    expect(await field.evaluate((element) => getComputedStyle(element).fontSize)).toBe('16px');
    await expectNoHorizontalScroll(page);
    await shot(page, 'p9-keyboard-open');
  });

  test('offline: the shell and the map fallback still render', async ({ page, context }) => {
    const yandex = await trackYandex(page);
    await page.goto('/uz');
    await context.setOffline(true);
    await expect(page.getByTestId('offline-banner')).toBeVisible();
    await expect(tabBar(page)).toBeVisible();
    await page
      .getByTestId('delivery-district')
      .filter({ visible: true })
      .getByRole('button', { name: 'Yetkazib berish manzilini tanlang' })
      .click();
    await page.getByRole('button', { name: 'Xaritada belgilash' }).click();
    await expect(page.getByTestId('address-picker').getByRole('dialog')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await context.setOffline(false);
    expect(yandex).toEqual([]);
  });
});

test.describe('map step without a Maps key (CI)', () => {
  test.beforeEach(async ({ page }) => browseAnonymously(page));

  for (const scheme of ['light', 'dark'] as const) {
    test(`${scheme}: custom fallback, no Yandex request, back to the list`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const yandex = await trackYandex(page);
      await page.addInitScript(
        (key) => window.localStorage.setItem(key, 'yunusobod'),
        DISTRICT_ITEM,
      );
      await page.goto('/uz');
      const card = page.getByTestId('delivery-district').filter({ visible: true });
      // Only the district and "Change": no fee, threshold or hours.
      await expect(card.getByTestId('delivery-district-name')).toHaveText('Yunusobod');
      await expect(card).not.toContainText('so‘m');
      await expect(card).not.toContainText(/\d{2}:\d{2}/);

      await card.getByRole('button', { name: /O‘zgartirish/ }).click();
      const sheet = page.getByRole('dialog', { name: 'Yetkazib berish manzili' });
      await sheet.getByRole('button', { name: 'Xaritada belgilash' }).click();
      const picker = page.getByRole('dialog', { name: 'Xaritada belgilash' });
      await expect(picker).toBeVisible();
      await expect(picker.getByTestId('map-unavailable')).toContainText(
        'Xarita bu yerda ishlamaydi',
      );
      await expect(picker.getByRole('button', { name: 'Orqaga' })).toBeFocused();
      await expectNoHorizontalScroll(page);
      await settled(page);
      await shot(page, `p9-map-fallback-${scheme}`);

      // Escape goes back to the district list, where the real choice is made.
      await page.keyboard.press('Escape');
      await expect(picker).toBeHidden();
      await expect(sheet).toBeVisible();
      // Without a key nothing was checked: no "point marked" or "saved" wording anywhere.
      await expect(page.getByText(/nuqta belgilan|saqlandi/i)).toHaveCount(0);
      expect(yandex).toEqual([]);
      // Still only the district code is remembered.
      expect(await page.evaluate(() => Object.keys(window.localStorage))).toEqual([DISTRICT_ITEM]);
    });
  }

  test('desktop: the map step is a centred panel', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/ru');
    await page
      .getByTestId('delivery-district')
      .filter({ visible: true })
      .getByRole('button', { name: 'Выберите адрес доставки' })
      .click();
    await page.getByRole('button', { name: 'Указать на карте' }).click();
    const picker = page.getByRole('dialog', { name: 'Указать на карте' });
    await expect(picker).toContainText('Карта здесь не работает');
    // Wait out the 200ms entrance before measuring and capturing.
    await expect(picker).toHaveCSS('opacity', '1');
    const box = await picker.boundingBox();
    expect(box !== null && box.width <= 896 && box.x > 0).toBe(true);
    await settled(page);
    await shot(page, 'p9-desktop-map-fallback');
  });
});

/**
 * A `Telegram.WebApp` stub with Bot API 8.0 safe areas. The session endpoints answer 401 locally,
 * so nothing reaches the Core API's login route.
 */
async function telegramFullscreen(
  page: Page,
  insets: {
    safe: { top: number; bottom: number; left: number; right: number };
    content: { top: number; bottom: number; left: number; right: number };
  },
): Promise<void> {
  await page.route(/^https:\/\/([^/]+\.)?telegram\.org\//, (route) => route.abort());
  await page.route('**/api/v1/auth/**', (route) =>
    route.fulfill({ status: 401, json: { error: { code: 'not_authenticated', message: '' } } }),
  );
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `(() => {
        const noop = () => {};
        const button = { onClick: noop, offClick: noop, show: noop, hide: noop, enable: noop,
          disable: noop, showProgress: noop, hideProgress: noop, setText: noop,
          isVisible: false, isActive: true, text: '' };
        // The native BackButton, observable from the test: visibility, listeners, a press.
        const backHandlers = new Set();
        const backButton = {
          isVisible: false,
          show() { backButton.isVisible = true; },
          hide() { backButton.isVisible = false; },
          onClick(handler) { backHandlers.add(handler); },
          offClick(handler) { backHandlers.delete(handler); },
        };
        window.__mmBackButton = {
          visible: () => backButton.isVisible,
          listeners: () => backHandlers.size,
          press: () => { for (const handler of [...backHandlers]) handler(); },
        };
        window.__mmFullscreenRequests = 0;
        window.Telegram = { WebApp: {
          initData: 'query_id=E2E&auth_date=1&hash=placeholder',
          initDataUnsafe: {}, colorScheme: 'light', themeParams: {}, platform: 'ios',
          version: '8.0', isVersionAtLeast: () => true,
          ready: noop, expand: noop, onEvent: noop, offEvent: noop,
          safeAreaInset: ${JSON.stringify(insets.safe)},
          contentSafeAreaInset: ${JSON.stringify(insets.content)},
          isFullscreen: true,
          requestFullscreen: () => { window.__mmFullscreenRequests += 1; },
          exitFullscreen: noop,
          BackButton: backButton, MainButton: { ...button },
        } };
      })();`,
    }),
  );
}

test.describe('Telegram fullscreen safe areas', () => {
  test('portrait: header below the status bar and Telegram controls, tab bar above the home area', async ({
    page,
  }) => {
    await telegramFullscreen(page, {
      safe: { top: 47, bottom: 34, left: 0, right: 0 },
      content: { top: 46, bottom: 0, left: 0, right: 0 },
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/uz');
    const header = page.locator('header').first();
    await expect
      .poll(() => header.evaluate((element) => getComputedStyle(element).paddingTop))
      .toBe('47px');
    // The logo fills Telegram's own Close / "…" row (47..93), centred between the buttons, and
    // the page (delivery address first) starts below that row, never under the buttons.
    const logo = await headerLogo(page).boundingBox();
    expect(logo).not.toBeNull();
    if (logo !== null) {
      expect(logo.y).toBeGreaterThanOrEqual(47);
      expect(logo.y + logo.height).toBeLessThanOrEqual(93);
      expect(Math.abs(logo.x + logo.width / 2 - 195)).toBeLessThanOrEqual(2);
    }
    const delivery = await page
      .getByTestId('delivery-district')
      .filter({ visible: true })
      .boundingBox();
    expect(delivery !== null && delivery.y >= 93).toBe(true);
    await expect
      .poll(() => tabBar(page).evaluate((element) => getComputedStyle(element).paddingBottom))
      .toBe('34px');
    await expectNoHorizontalScroll(page);
    await shot(page, 'p9-telegram-fullscreen-portrait');

    // The map step is the customer's explicit action; already fullscreen, so no second request.
    await page
      .getByTestId('delivery-district')
      .filter({ visible: true })
      .getByRole('button', { name: 'Yetkazib berish manzilini tanlang' })
      .click();
    await page.getByRole('button', { name: 'Xaritada belgilash' }).click();
    const back = page.getByRole('button', { name: 'Orqaga' });
    const backBox = await back.boundingBox();
    expect(backBox !== null && backBox.y >= 93).toBe(true);
    expect(
      await page.evaluate(
        () => (window as { __mmFullscreenRequests?: number }).__mmFullscreenRequests,
      ),
    ).toBe(0);
    await settled(page);
    await shot(page, 'p9-telegram-fullscreen-map');
  });

  test('landscape: side insets pad the header and the tab bar', async ({ page }) => {
    await telegramFullscreen(page, {
      safe: { top: 0, bottom: 21, left: 59, right: 59 },
      content: { top: 38, bottom: 0, left: 0, right: 0 },
    });
    await page.setViewportSize({ width: 740, height: 360 });
    await page.goto('/ru');
    const header = page.locator('header').first();
    await expect
      .poll(() => header.evaluate((element) => getComputedStyle(element).paddingLeft))
      .toBe('59px');
    await expect
      .poll(() => tabBar(page).evaluate((element) => getComputedStyle(element).paddingRight))
      .toBe('59px');
    await expectNoHorizontalScroll(page);
    await shot(page, 'p9-telegram-fullscreen-landscape');
  });
});

interface BackButtonProbe {
  visible: () => boolean;
  listeners: () => number;
  press: () => void;
}

function backButtonVisible(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    (window as unknown as { __mmBackButton: BackButtonProbe }).__mmBackButton.visible(),
  );
}

async function pressBackButton(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __mmBackButton: BackButtonProbe }).__mmBackButton.press();
  });
}

/** Any in-page back control, in either language. */
async function expectNoInAppBack(page: Page): Promise<void> {
  const back = /orqaga|qaytish|barcha buyurtmalar|назад|вернуться|все заказы/i;
  await expect(page.getByRole('link', { name: back })).toHaveCount(0);
  await expect(page.getByRole('button', { name: back })).toHaveCount(0);
}

const PORTRAIT_320 = {
  safe: { top: 47, bottom: 34, left: 0, right: 0 },
  content: { top: 46, bottom: 0, left: 0, right: 0 },
};

/** Telegram's own Close and "…" buttons take about this much on each side of their row. */
const TELEGRAM_CONTROLS = 104;

test.describe('Telegram fullscreen: page titles and the native BackButton', () => {
  test('320px: logo at home, the title elsewhere, never under Close or "…"', async ({ page }) => {
    await telegramFullscreen(page, PORTRAIT_320);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/uz');
    await pageSettled(page);
    await expect(headerLogo(page)).toBeVisible();
    await expect(headerTitle(page)).toHaveCount(0);
    await expect.poll(() => backButtonVisible(page)).toBe(false);

    for (const [path, title] of [
      ['/uz/catalog', 'Katalog'],
      ['/uz/cart', 'Savat'],
      ['/uz/profile', 'Profil'],
      ['/uz/search?q=olma', 'Qidiruv'],
      ['/uz/orders', 'Buyurtmalar'],
      ['/ru/catalog', 'Каталог'],
      ['/ru/checkout', 'Оформление'],
    ] as const) {
      await page.goto(path);
      await pageSettled(page);
      const heading = headerTitle(page);
      await expect(heading, path).toHaveText(title);
      await expect(headerLogo(page)).toHaveCount(0);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      const box = await heading.boundingBox();
      expect(box, path).not.toBeNull();
      if (box !== null) {
        // Inside Telegram's row (47..93) and clear of its buttons on both sides.
        expect(box.y, path).toBeGreaterThanOrEqual(47);
        expect(box.y + box.height, path).toBeLessThanOrEqual(93);
        expect(box.x, path).toBeGreaterThanOrEqual(TELEGRAM_CONTROLS);
        expect(box.x + box.width, path).toBeLessThanOrEqual(320 - TELEGRAM_CONTROLS);
      }
      await expectNoInAppBack(page);
      await expectNoHorizontalScroll(page);
    }
    await page.goto('/uz/catalog');
    await pageSettled(page);
    await shot(page, 'shell-320-catalog-title');
  });

  test('a long product name is cut with an ellipsis inside the slot', async ({ page }) => {
    await telegramFullscreen(page, PORTRAIT_320);
    await page.setViewportSize({ width: 320, height: 640 });
    const name = 'Qaymoqli shokoladli muzqaymoq, vanilli, katta oilaviy qadoq 1 kg';
    // The page fetches server-side, so the long name is set on the rendered page itself.
    await page.goto('/uz/p/demo-banan');
    await pageSettled(page);
    const heading = headerTitle(page);
    await heading.evaluate((element, text) => {
      element.textContent = text;
    }, name);
    const fit = await heading.evaluate((element) => ({
      overflow: getComputedStyle(element).textOverflow,
      clipped: element.scrollWidth > element.clientWidth,
      right: element.getBoundingClientRect().right,
      left: element.getBoundingClientRect().left,
    }));
    expect(fit.overflow).toBe('ellipsis');
    expect(fit.clipped).toBe(true);
    expect(fit.left).toBeGreaterThanOrEqual(TELEGRAM_CONTROLS);
    expect(fit.right).toBeLessThanOrEqual(320 - TELEGRAM_CONTROLS);
    await expectNoHorizontalScroll(page);
    await shot(page, 'shell-320-long-title');
  });

  test('BackButton: hidden on the tab roots, shown below them, back in history', async ({
    page,
  }) => {
    await telegramFullscreen(page, PORTRAIT_320);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/uz');
    await pageSettled(page);
    await expect.poll(() => backButtonVisible(page)).toBe(false);

    const bar = tabBar(page);
    await bar.getByRole('link', { name: 'Katalog' }).click();
    await expect(page).toHaveURL(/\/uz\/catalog$/);
    await expect.poll(() => backButtonVisible(page)).toBe(false);

    await page.getByTestId('catalog-category').first().click();
    await expect(page).toHaveURL(/\/uz\/c\//);
    await pageSettled(page);
    await expect.poll(() => backButtonVisible(page)).toBe(true);
    await expectNoInAppBack(page);
    // The category name is the title; no breadcrumb or second heading in the page.
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

    await pressBackButton(page);
    await expect(page).toHaveURL(/\/uz\/catalog$/);
    await expect.poll(() => backButtonVisible(page)).toBe(false);
    // One listener at a time, removed when the button hides.
    expect(
      await page.evaluate(() =>
        (window as unknown as { __mmBackButton: BackButtonProbe }).__mmBackButton.listeners(),
      ),
    ).toBe(0);

    for (const tab of ['Savat', 'Profil', 'Bosh sahifa']) {
      await bar.getByRole('link', { name: tab }).click();
      await expect.poll(() => backButtonVisible(page), tab).toBe(false);
    }
  });

  test('BackButton on a deep link: climbs to the logical parent, product -> category -> catalog', async ({
    context,
  }) => {
    // A fresh tab: the Mini App opened straight on a product, nothing to go back to.
    const page = await context.newPage();
    await telegramFullscreen(page, PORTRAIT_320);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/uz/p/demo-banan');
    await pageSettled(page);
    await expect(headerTitle(page)).toHaveText('Banan');
    await expect.poll(() => backButtonVisible(page)).toBe(true);
    await expectNoInAppBack(page);

    await pressBackButton(page);
    await expect(page).toHaveURL(/\/uz\/c\/demo-mevalar$/);
    await pageSettled(page);
    await expect(headerTitle(page)).not.toBeEmpty();
    await expect.poll(() => backButtonVisible(page)).toBe(true);

    await pressBackButton(page);
    await expect(page).toHaveURL(/\/uz\/c\/demo-mevalar-sabzavotlar$/);

    await pressBackButton(page);
    await expect(page).toHaveURL(/\/uz\/catalog$/);
    await expect.poll(() => backButtonVisible(page)).toBe(false);
  });
});

test.describe('zoom and scrolling', () => {
  test.beforeEach(async ({ page }) => browseAnonymously(page));

  test('no pinch or double-tap zoom; vertical overscroll left native', async ({ page }) => {
    await page.goto('/uz/catalog');
    await pageSettled(page);
    const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(viewport).toContain('maximum-scale=1');
    expect(viewport).toContain('user-scalable=no');
    const root = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        touchAction: style.touchAction,
        overscrollY: style.overscrollBehaviorY,
        overscrollX: style.overscrollBehaviorX,
      };
    });
    expect(root.touchAction).toBe('pan-x pan-y');
    expect(root.overscrollY).toBe('auto');
    expect(root.overscrollX).toBe('none');
    // The sticky header is solid: no backdrop blur re-composited on every scroll frame.
    expect(
      await page
        .locator('header')
        .first()
        .evaluate((element) => getComputedStyle(element).backdropFilter),
    ).toBe('none');
    // WebKit's pinch gesture is cancelled.
    expect(
      await page.evaluate(() => {
        const event = new Event('gesturestart', { cancelable: true, bubbles: true });
        document.body.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    ).toBe(true);
    // The catalog is a normal document scroll (no nested scroller to get stuck in).
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });
});
