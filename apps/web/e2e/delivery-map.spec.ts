import { expect, test, type Page, type Request } from '@playwright/test';

/**
 * The address picker with a Maps key: the map and the address form on one screen; moving the map
 * reverse-geocodes the pin into street and house; "Shu yerga yetkazish" saves the address (point
 * and text) on this device. No area, price or free-delivery wording anywhere. The Yandex SDK
 * is a stub served by `page.route` for `https://api-maps.yandex.ru/**`, and the Geocoder HTTP API
 * is answered locally; every other Yandex host is aborted. CI never uses a real key and never
 * talks to Yandex.
 *
 * Needs a second storefront server started with a placeholder key, for example
 *   YANDEX_MAPS_JAVASCRIPT_API_KEY=00000000-0000-4000-8000-000000000000 \
 *   YANDEX_MAPS_GEOCODER_API_KEY=11111111-1111-4111-8111-111111111111 \
 *     pnpm --filter @muniramarket/web exec next start --port 3002
 * and `E2E_MAPS_BASE_URL=http://localhost:3002`. Without it these specs are skipped; the
 * no-key fallback runs against the normal server in `mobile-shell.spec.ts`.
 */

const MAPS_BASE_URL = process.env['E2E_MAPS_BASE_URL'];
const ADDRESS_ITEM = 'mm.delivery-address.v1';

test.skip(
  MAPS_BASE_URL === undefined || MAPS_BASE_URL === '',
  'Set E2E_MAPS_BASE_URL to a storefront started with placeholder Yandex JavaScript and Geocoder keys.',
);
test.use({ baseURL: MAPS_BASE_URL });

type Answer = 'house' | 'kvartal' | 'fail';

/**
 * A tiny `ymaps3`: a map whose centre the test can move (`__mapStub.pan`, which fires the
 * gesture listener like a drag). The street/house lookup is intercepted at the Geocoder HTTP
 * endpoint below, so this test never needs Yandex Search API access.
 */
const STUB_SDK = String.raw`
(() => {
  const stub = (window.__mapStub = window.__mapStub || {});
  stub.listeners = [];
  stub.maps = [];
  class YMap {
    constructor(element, props) {
      this.element = element;
      this._center = props.location.center;
      this._zoom = props.location.zoom;
      const tile = document.createElement('div');
      tile.setAttribute('data-stub-map', '');
      tile.style.cssText =
        'position:absolute;inset:0;background:repeating-linear-gradient(45deg,#e7e5e4 0 24px,#f5f5f4 24px 48px)';
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
  };
})();
`;

/** The Geocoder's first (nearest house) result: its name and address components. */
const GEOCODER_RESULTS: Record<
  Exclude<Answer, 'fail'>,
  { name: string; components: Array<{ kind: string; name: string }> }
> = {
  house: {
    name: 'улица Бунёдкор, 15',
    components: [
      { kind: 'country', name: 'Узбекистан' },
      { kind: 'locality', name: 'Ташкент' },
      { kind: 'street', name: 'улица Бунёдкор' },
      { kind: 'house', name: '15' },
    ],
  },
  // No street component: the name minus the house number stands in for it.
  kvartal: {
    name: '9-й квартал, 5',
    components: [
      { kind: 'country', name: 'Узбекистан' },
      { kind: 'locality', name: 'Ташкент' },
      { kind: 'house', name: '5' },
    ],
  },
};

async function stubYandex(
  page: Page,
  answer: Answer = 'house',
): Promise<{ blocked: string[]; geocodes: string[] }> {
  const blocked: string[] = [];
  const geocodes: string[] = [];
  await page.route(/^https:\/\/([^/]+\.)?(yandex\.(ru|net|com|uz)|yastatic\.net)\//, (route) => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://api-maps.yandex.ru' && url.pathname === '/v3/') {
      return route.fulfill({ contentType: 'application/javascript', body: STUB_SDK });
    }
    blocked.push(url.origin);
    return route.abort();
  });
  await page.route('https://geocode-maps.yandex.ru/v1**', (route) => {
    geocodes.push(route.request().url());
    if (answer === 'fail') return route.fulfill({ status: 403, body: '{}' });
    return route.fulfill({
      contentType: 'application/json',
      json: {
        response: {
          GeoObjectCollection: {
            featureMember: [
              {
                GeoObject: {
                  name: GEOCODER_RESULTS[answer].name,
                  metaDataProperty: {
                    GeocoderMetaData: {
                      Address: { Components: GEOCODER_RESULTS[answer].components },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    });
  });
  return { blocked, geocodes };
}

async function browseAnonymously(page: Page): Promise<void> {
  await page.route(/^https:\/\/([^/]+\.)?telegram\.org\//, (route) => route.abort());
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({ status: 401, json: { error: { code: 'not_authenticated', message: '' } } }),
  );
}

/** Every request to our own origin, to prove picking an address sends nothing to our API. */
function recordOwnRequests(page: Page): Request[] {
  const own: Request[] = [];
  const origin = new URL(MAPS_BASE_URL ?? 'http://localhost').origin;
  page.on('request', (request) => {
    if (new URL(request.url()).origin === origin) own.push(request);
  });
  return own;
}

async function openMap(page: Page, locale: 'uz' | 'ru' = 'uz') {
  const card = page.getByTestId('delivery-address').filter({ visible: true });
  // One tap: straight to the map and the form.
  await card.getByRole('button').first().click();
  const picker = page.getByRole('dialog', {
    name: locale === 'uz' ? 'Yetkazish manzili' : 'Адрес доставки',
  });
  await expect(picker.getByTestId('map-canvas')).toBeVisible();
  await expect(picker.locator('[data-stub-map]')).toBeVisible();
  await expect(picker.getByTestId('address-form')).toBeVisible();
  return picker;
}

function pan(page: Page, center: [number, number]): Promise<void> {
  return page.evaluate(
    (c) => (window as unknown as { __mapStub: { pan: (c: number[]) => void } }).__mapStub.pan(c),
    center,
  );
}

/** No price or free-delivery wording around the address. */
const NO_DELIVERY_TERMS = /so‘m|сум|bepul|бесплат/i;

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

test.beforeEach(async ({ page }) => browseAnonymously(page));

test('pick a point: street and house are filled in, "Shu yerga yetkazish" saves the address', async ({
  page,
}) => {
  const { blocked, geocodes } = await stubYandex(page, 'house');
  const own = recordOwnRequests(page);
  await page.goto('/uz');
  const picker = await openMap(page);

  await expect(
    picker.getByRole('img', { name: 'Yetkazish nuqtasi xarita markazida' }),
  ).toBeVisible();
  // The city centre is nobody's address: nothing is looked up until the customer moves the map.
  expect(geocodes).toEqual([]);
  await pan(page, [69.2041, 41.2856]);
  await expect(picker.getByLabel('Ko‘cha')).toHaveValue('улица Бунёдкор');
  await expect(picker.getByLabel('Uy')).toHaveValue('15');
  expect(geocodes).toHaveLength(1);
  const lookup = new URL(geocodes[0] ?? '');
  expect(lookup.searchParams.get('geocode')).toBe('69.204100,41.285600');
  expect(lookup.searchParams.get('kind')).toBe('house');

  await picker.getByLabel('Xonadon').fill('7');
  await picker.getByLabel('Mo‘ljal yoki izoh').fill('Demo mo‘ljal');
  await expect(picker).not.toContainText(NO_DELIVERY_TERMS);
  await picker.getByRole('button', { name: 'Shu yerga yetkazish' }).click();
  await expect(picker).toBeHidden();

  const card = page.getByTestId('delivery-address').filter({ visible: true });
  await expect(card.getByTestId('delivery-address-line')).toHaveText(
    'улица Бунёдкор, 15, 7-xonadon',
  );
  await expect(card).not.toContainText(NO_DELIVERY_TERMS);
  const saved = await page.evaluate((key) => window.localStorage.getItem(key), ADDRESS_ITEM);
  expect(JSON.parse(saved ?? 'null')).toEqual({
    lat: 41.2856,
    lon: 69.2041,
    street: 'улица Бунёдкор',
    house: '15',
    apartment: '7',
    entrance: '',
    floor: '',
    landmark: 'Demo mo‘ljal',
  });
  // Choosing an address talks to Yandex only: the point never reaches our API before an order.
  expect(
    own.filter((request) =>
      /41\.2856|69\.2041/.test(`${request.url()} ${request.postData() ?? ''}`),
    ),
  ).toEqual([]);
  expect(blocked).toEqual([]);
});

test('a kvartal address: the neighbourhood stands in for the street (Russian)', async ({
  page,
}) => {
  await stubYandex(page, 'kvartal');
  await page.goto('/ru');
  const picker = await openMap(page, 'ru');
  await pan(page, [69.2, 41.29]);
  await expect(picker.getByLabel('Улица')).toHaveValue('9-й квартал');
  await expect(picker.getByLabel('Дом')).toHaveValue('5');
});

test('lookup fails: the customer types street and house; the pin is still the point', async ({
  page,
}) => {
  await stubYandex(page, 'fail');
  await page.goto('/uz');
  const picker = await openMap(page);
  await pan(page, [69.25, 41.32]);
  await expect(picker.getByTestId('map-status')).toHaveText(
    'Manzilni aniqlab bo‘lmadi. Ko‘cha va uyni yozing.',
  );
  await picker.getByRole('button', { name: 'Shu yerga yetkazish' }).click();
  await expect(picker.getByText('To‘ldirish shart').first()).toBeVisible();
  await picker.getByLabel('Ko‘cha').fill('Demo ko‘cha');
  await picker.getByLabel('Uy').fill('3');
  await picker.getByRole('button', { name: 'Shu yerga yetkazish' }).click();
  await expect(picker).toBeHidden();
});

test('"Shu yerga yetkazish" before the map moved asks to place the pin', async ({ page }) => {
  const { geocodes } = await stubYandex(page, 'house');
  await page.goto('/uz');
  const picker = await openMap(page);
  await picker.getByRole('button', { name: 'Shu yerga yetkazish' }).click();
  await expect(picker.getByTestId('map-place-pin')).toBeVisible();
  await expect(picker).toBeVisible();
  expect(geocodes).toEqual([]);
});

test.describe('geolocation', () => {
  test('permission denied: explained in our UI, the map still works', async ({ page, context }) => {
    await context.clearPermissions();
    await stubYandex(page, 'house');
    await page.goto('/uz');
    const picker = await openMap(page);
    await picker.getByRole('button', { name: 'Mening joylashuvim' }).click();
    await expect(picker.getByTestId('map-status')).toContainText('Joylashuvga ruxsat berilmagan');
    await pan(page, [69.2041, 41.2856]);
    await expect(picker.getByLabel('Uy')).toHaveValue('15');
  });

  test('granted: "Mening joylashuvim" moves the map there and fills the address', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 41.2856, longitude: 69.2041 });
    const { geocodes } = await stubYandex(page, 'house');
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
    await expect(picker.getByLabel('Ko‘cha')).toHaveValue('улица Бунёдкор');
    expect(geocodes).toHaveLength(1);
  });
});

test.describe('layout', () => {
  for (const width of [320, 390]) {
    test(`${String(width)}px: immersive, actions in thumb reach, no sideways scroll`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 700 });
      await stubYandex(page, 'house');
      await page.goto('/uz');
      const picker = await openMap(page);
      // Measure after the slide-in, not during it.
      await page.evaluate(() =>
        Promise.all(
          document.getAnimations().map((animation) => animation.finished.catch(() => null)),
        ),
      );
      await expect(picker).toHaveCSS('opacity', '1');
      const box = await picker.boundingBox();
      expect(box?.width).toBe(width);
      // "Mening joylashuvim" and "Shu yerga yetkazish" sit at the bottom edge of the sheet.
      const actions = await picker.getByTestId('map-actions').boundingBox();
      expect(actions !== null && actions.y + actions.height >= 700 - 2).toBe(true);
      const locate = await picker.getByRole('button', { name: 'Mening joylashuvim' }).boundingBox();
      const confirm = await picker
        .getByRole('button', { name: 'Shu yerga yetkazish' })
        .boundingBox();
      expect(locate !== null && locate.height >= 44 && locate.y >= (actions?.y ?? 0)).toBe(true);
      expect(confirm !== null && confirm.height >= 44).toBe(true);
      await pan(page, [69.2041, 41.2856]);
      await expect(picker.getByLabel('Uy')).toHaveValue('15');
      await shot(page, `map-picker-${String(width)}`);
      await expectNoHorizontalScroll(page);
    });
  }

  test('desktop, dark: a centred dialog with the map beside the form', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await stubYandex(page, 'house');
    await page.goto('/ru');
    const picker = await openMap(page, 'ru');
    const dialog = await picker.boundingBox();
    expect(dialog !== null && dialog.width <= 896 && dialog.x > 0).toBe(true);
    const map = await picker.getByTestId('map-canvas').boundingBox();
    const panel = await picker.getByTestId('address-form').boundingBox();
    expect(map !== null && panel !== null && panel.x >= map.x + map.width - 1).toBe(true);
    await pan(page, [69.2041, 41.2856]);
    await expect(picker.getByLabel('Дом')).toHaveValue('15');
    await picker.getByRole('button', { name: 'Доставить сюда' }).click();
    await expect(picker).toBeHidden();
    await shot(page, 'map-desktop-dark');
    await expectNoHorizontalScroll(page);
  });
});
