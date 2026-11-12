import { expect, test, type Page, type Request } from '@playwright/test';

/**
 * The map step with a Maps key: pick a point under the centre pin, "Deliver here", and a real
 * delivery result from the live (seeded) zones. The Yandex SDK is a stub served by `page.route`
 * for `https://api-maps.yandex.ru/**`; every other Yandex host is aborted. CI never uses a real
 * key and never talks to Yandex.
 *
 * Needs a second storefront server started with a placeholder key, for example
 *   YANDEX_MAPS_JAVASCRIPT_API_KEY=00000000-0000-4000-8000-000000000000 \
 *   YANDEX_MAPS_GEOCODER_API_KEY=11111111-1111-4111-8111-111111111111 \
 *     pnpm --filter @muniramarket/web exec next start --port 3002
 * and `E2E_MAPS_BASE_URL=http://localhost:3002`. Without it these specs are skipped; the
 * no-key fallback runs against the normal server in `mobile-shell.spec.ts`.
 *
 * Seeded zones (services/api/app/dev/seed.py): chilonzor is in "Demo chekka zona" (25 000 fee,
 * 100 000 minimum, free from 500 000, 09:00–20:00); bektemir and yangihayot are in an inactive
 * zone, so not served.
 */

const MAPS_BASE_URL = process.env['E2E_MAPS_BASE_URL'];
const DISTRICT_ITEM = 'mm.delivery-district.v1';

test.skip(
  MAPS_BASE_URL === undefined || MAPS_BASE_URL === '',
  'Set E2E_MAPS_BASE_URL to a storefront started with placeholder Yandex JavaScript and Geocoder keys.',
);
test.use({ baseURL: MAPS_BASE_URL });

type Answer = 'chilonzor' | 'bektemir' | 'samarkand' | 'fail';

/**
 * A tiny `ymaps3`: a map whose centre the test can move (`__mapStub.pan`, which fires the
 * gesture listener like a drag), and `search` answering from `__mapStub.answer`. Every search
 * text is recorded in `__mapStub.searches`.
 */
const STUB_SDK = String.raw`
(() => {
  const stub = (window.__mapStub = window.__mapStub || {});
  stub.searches = [];
  stub.listeners = [];
  stub.maps = [];
  const answers = {
    chilonzor: [
      { properties: { name: 'Bunyodkor ko‘chasi, 15', description: 'Toshkent, O‘zbekiston' } },
      { properties: { name: 'Chilonzor tumani', description: 'Toshkent, O‘zbekiston' } },
    ],
    bektemir: [{ properties: { name: 'Бектемирский район', description: 'Ташкент, Узбекистан' } }],
    samarkand: [{ properties: { name: 'Самарканд', description: 'Узбекистан' } }],
  };
  class YMap {
    constructor(element, props) {
      this.element = element;
      this._center = props.location.center;
      this._zoom = props.location.zoom;
      const tile = document.createElement('div');
      tile.setAttribute('data-stub-map', '');
      tile.style.cssText =
        'position:absolute;inset:0;background:repeating-linear-gradient(45deg,#d9e6d3 0 24px,#e8efe4 24px 48px)';
      element.append(tile);
      stub.maps.push(this);
    }
    get center() { return this._center; }
    get zoom() { return this._zoom; }
    addChild() { return this; }
    update(props) {
      if (props.location) { this._center = props.location.center; this._zoom = props.location.zoom; }
    }
    destroy() { this.element.replaceChildren(); }
  }
  class YMapListener { constructor(props) { stub.listeners.push(props); } }
  stub.pan = (center) => {
    for (const l of stub.listeners) l.onActionStart && l.onActionStart();
    for (const m of stub.maps) m._center = center;
    for (const l of stub.listeners) l.onActionEnd && l.onActionEnd();
  };
  window.ymaps3 = {
    ready: Promise.resolve(),
    YMap,
    YMapListener,
    YMapDefaultSchemeLayer: class {},
    YMapDefaultFeaturesLayer: class {},
    getDefaultConfig: () => ({ setApikeys() {} }),
    search: (options) => {
      stub.searches.push(options.text);
      const answer = stub.answer || 'chilonzor';
      if (answer === 'fail') return Promise.reject(new Error('403 Forbidden'));
      return Promise.resolve(answers[answer] || []);
    },
  };
})();
`;

async function stubYandex(page: Page, answer: Answer = 'chilonzor'): Promise<string[]> {
  const blocked: string[] = [];
  await page.route(/^https:\/\/([^/]+\.)?(yandex\.(ru|net|com|uz)|yastatic\.net)\//, (route) => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://api-maps.yandex.ru' && url.pathname === '/v3/') {
      return route.fulfill({ contentType: 'application/javascript', body: STUB_SDK });
    }
    blocked.push(url.origin);
    return route.abort();
  });
  await page.addInitScript((value) => {
    (window as unknown as { __mapStub: { answer: string } }).__mapStub = { answer: value };
  }, answer);
  return blocked;
}

async function browseAnonymously(page: Page): Promise<void> {
  await page.route(/^https:\/\/([^/]+\.)?telegram\.org\//, (route) => route.abort());
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({ status: 401, json: { error: { code: 'not_authenticated', message: '' } } }),
  );
}

/** Every request to our own origin, to prove no coordinate ever reaches it. */
function recordOwnRequests(page: Page): Request[] {
  const own: Request[] = [];
  const origin = new URL(MAPS_BASE_URL ?? 'http://localhost').origin;
  page.on('request', (request) => {
    if (new URL(request.url()).origin === origin) own.push(request);
  });
  return own;
}

async function openMap(page: Page, locale: 'uz' | 'ru' = 'uz') {
  const card = page.getByTestId('delivery-district').filter({ visible: true });
  await card.getByRole('button').first().click();
  await page
    .getByRole('button', { name: locale === 'uz' ? 'Xaritada belgilash' : 'Указать на карте' })
    .click();
  const picker = page.getByRole('dialog', {
    name: locale === 'uz' ? 'Xaritada belgilash' : 'Указать на карте',
  });
  await expect(picker.getByTestId('map-canvas')).toBeVisible();
  await expect(picker.locator('[data-stub-map]')).toBeVisible();
  return picker;
}

/** Set `E2E_SHOTS_DIR` to save the screenshots used in the PR description. */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['E2E_SHOTS_DIR'];
  if (dir === undefined || dir === '') return;
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => null))),
  );
  await page.screenshot({ path: `${dir}/${name}.png` });
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `page scrolls sideways by ${String(overflow)}px`).toBeLessThanOrEqual(0);
}

async function searches(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __mapStub: { searches: string[] } }).__mapStub.searches,
  );
}

test.beforeEach(async ({ page }) => browseAnonymously(page));

test('served: pick a point, "Deliver here", real zone rules, choose the district', async ({
  page,
}) => {
  const blocked = await stubYandex(page, 'chilonzor');
  const own = recordOwnRequests(page);
  await page.goto('/uz');
  const picker = await openMap(page);

  await expect(
    picker.getByRole('img', { name: 'Yetkazish nuqtasi xarita markazida' }),
  ).toBeVisible();
  // Nothing is looked up before the customer confirms.
  expect(await searches(page)).toEqual([]);
  await page.evaluate(() =>
    (window as unknown as { __mapStub: { pan: (c: number[]) => void } }).__mapStub.pan([
      69.2041, 41.2856,
    ]),
  );
  await picker.getByRole('button', { name: 'Shu yerga yetkazish' }).click();

  const result = picker.getByTestId('map-result');
  await expect(result).toHaveAttribute('data-status', 'served');
  await expect(result.getByRole('heading')).toHaveText('Chilonzor tumaniga yetkazib beramiz');
  await expect(result).toContainText('Demo chekka zona');
  await expect(result.getByTestId('demo-badge')).toHaveText('Demo');
  await expect(result.getByTestId('demo-note')).toContainText('admin panelda');
  await expect(result).toContainText(/25\s000\sso‘m/);
  await expect(result).toContainText(/100\s000\sso‘m/);
  await expect(result).toContainText(/500\s000\sso‘m dan/);
  await expect(result).toContainText('09:00–20:00');
  expect(await searches(page)).toEqual(['69.204100,41.285600']);
  await shot(page, 'map-served-uz');
  await expectNoHorizontalScroll(page);

  await result.getByRole('button', { name: 'Chilonzor tumanini tanlash' }).click();
  await expect(picker).toBeHidden();
  const card = page.getByTestId('delivery-district').filter({ visible: true });
  await expect(card.getByTestId('delivery-district-name')).toHaveText('Chilonzor');

  // Privacy: only the district code is kept; no coordinate in storage, cookies, URL or our API.
  const storage = await page.evaluate(() => ({
    local: Object.entries(window.localStorage),
    session: window.sessionStorage.length,
    cookie: document.cookie,
    href: window.location.href,
  }));
  expect(storage.local).toEqual([[DISTRICT_ITEM, 'chilonzor']]);
  expect(storage.session).toBe(0);
  expect(storage.cookie).not.toMatch(/69\.2|41\.2/);
  expect(storage.href).not.toMatch(/69\.2|41\.2/);
  for (const request of own) {
    expect(request.url()).not.toMatch(/69\.20|41\.28/);
    expect(request.postData() ?? '').not.toMatch(/69\.20|41\.28/);
  }
  expect(blocked).toEqual([]);
});

test('not served (Russian): names the district and offers served neighbours', async ({ page }) => {
  await stubYandex(page, 'bektemir');
  await page.goto('/ru');
  const picker = await openMap(page, 'ru');
  await picker.getByRole('button', { name: 'Доставить сюда' }).click();
  const result = picker.getByTestId('map-result');
  await expect(result).toHaveAttribute('data-status', 'not-served');
  await expect(result.getByRole('heading')).toHaveText('В район «Бектемирский» пока не доставляем');
  await expect(result).toContainText('Доставляем в соседние районы:');
  await shot(page, 'map-not-served-ru');
  await expect(result).not.toContainText('Доставляем в этот район');
  // Bektemir borders Yashnobod (demo-chekka) and Sergeli (demo-janubiy).
  const neighbour = result.getByRole('button', { name: /Яшнабад/ });
  await expect(neighbour).toBeVisible();
  await neighbour.click();
  await expect(picker).toBeHidden();
  expect(await page.evaluate((key) => window.localStorage.getItem(key), DISTRICT_ITEM)).toBe(
    'yashnobod',
  );
});

test('reverse geocoding fails: never claims delivery, falls back to the district list', async ({
  page,
}) => {
  await stubYandex(page, 'fail');
  await page.addInitScript((key) => window.localStorage.setItem(key, 'yunusobod'), DISTRICT_ITEM);
  await page.goto('/uz');
  const picker = await openMap(page);
  await picker.getByRole('button', { name: 'Shu yerga yetkazish' }).click();
  const result = picker.getByTestId('map-result');
  await expect(result).toHaveAttribute('data-status', 'lookup-failed');
  await expect(result).toContainText('Tumanni avtomatik tekshirib bo‘lmadi');
  await expect(result).not.toContainText('yetkazib beramiz');
  await expect(result.getByRole('heading')).toBeFocused();
  await shot(page, 'map-lookup-failed');

  await result.getByRole('button', { name: 'Tumanni ro‘yxatdan tanlash' }).click();
  await expect(picker).toBeHidden();
  const sheet = page.getByRole('dialog', { name: 'Yetkazib berish manzili' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('radio', { name: 'Yunusobod' })).toBeChecked();
  expect(await page.evaluate((key) => window.localStorage.getItem(key), DISTRICT_ITEM)).toBe(
    'yunusobod',
  );
});

test('outside Tashkent: honest result, "Change the point" returns to the map', async ({ page }) => {
  await stubYandex(page, 'samarkand');
  await page.goto('/uz');
  const picker = await openMap(page);
  await page.evaluate(() =>
    (window as unknown as { __mapStub: { pan: (c: number[]) => void } }).__mapStub.pan([
      66.9597, 39.6542,
    ]),
  );
  await picker.getByRole('button', { name: 'Shu yerga yetkazish' }).click();
  const result = picker.getByTestId('map-result');
  await expect(result).toHaveAttribute('data-status', 'outside');
  await expect(result).toContainText('Toshkent shahridan tashqarida');
  await shot(page, 'map-outside');
  await result.getByRole('button', { name: 'Nuqtani o‘zgartirish' }).click();
  await expect(result).toBeHidden();
  await expect(picker.getByRole('button', { name: 'Shu yerga yetkazish' })).toBeEnabled();
});

test.describe('geolocation', () => {
  test('permission denied: explained in our UI, the pin still works', async ({ page, context }) => {
    await context.clearPermissions();
    await stubYandex(page, 'chilonzor');
    await page.goto('/uz');
    const picker = await openMap(page);
    await picker.getByRole('button', { name: 'Mening joylashuvim' }).click();
    await expect(picker.getByTestId('map-locate-status')).toContainText(
      'Joylashuvga ruxsat berilmagan',
    );
    // No native dialog: the page handles it.
    await picker.getByRole('button', { name: 'Shu yerga yetkazish' }).click();
    await expect(picker.getByTestId('map-result')).toHaveAttribute('data-status', 'served');
  });

  test('granted: "My location" only moves the map; it is used after "Deliver here"', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 41.2856, longitude: 69.2041 });
    await stubYandex(page, 'chilonzor');
    await page.goto('/uz');
    const picker = await openMap(page);
    await picker.getByRole('button', { name: 'Mening joylashuvim' }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __mapStub: { maps: Array<{ center: number[] }> } }).__mapStub
              .maps[0]?.center,
        ),
      )
      .toEqual([69.2041, 41.2856]);
    expect(await searches(page)).toEqual([]);
    await picker.getByRole('button', { name: 'Shu yerga yetkazish' }).click();
    await expect(picker.getByTestId('map-result')).toHaveAttribute('data-status', 'served');
    expect(await searches(page)).toEqual(['69.204100,41.285600']);
  });
});

test.describe('layout', () => {
  for (const width of [320, 390]) {
    test(`${String(width)}px: immersive, result readable, no sideways scroll`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await stubYandex(page, 'chilonzor');
      await page.goto('/uz');
      const picker = await openMap(page);
      const box = await picker.boundingBox();
      expect(box?.width).toBe(width);
      await picker.getByRole('button', { name: 'Shu yerga yetkazish' }).click();
      await expect(picker.getByTestId('map-result')).toBeVisible();
      await expect(
        picker.getByRole('button', { name: 'Chilonzor tumanini tanlash' }),
      ).toBeInViewport();
      await shot(page, `map-result-${String(width)}`);
      await expectNoHorizontalScroll(page);
    });
  }

  test('desktop, dark: a centred dialog with the map beside the panel', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await stubYandex(page, 'chilonzor');
    await page.goto('/ru');
    const picker = await openMap(page, 'ru');
    const dialog = await picker.boundingBox();
    expect(dialog !== null && dialog.width <= 896 && dialog.x > 0).toBe(true);
    const map = await picker.getByTestId('map-canvas').boundingBox();
    const panel = await picker.getByTestId('map-actions').boundingBox();
    expect(map !== null && panel !== null && panel.x >= map.x + map.width - 1).toBe(true);
    await picker.getByRole('button', { name: 'Доставить сюда' }).click();
    await expect(picker.getByTestId('map-result')).toContainText('Демо окраинная зона');
    await shot(page, 'map-desktop-dark');
    await expectNoHorizontalScroll(page);
  });
});
