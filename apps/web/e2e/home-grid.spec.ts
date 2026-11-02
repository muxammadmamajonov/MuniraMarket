import { expect, test } from '@playwright/test';
import {
  emptyCart,
  installTelegramStub,
  mainButton,
  pressMainButton,
  requireBotToken,
  trackCspViolations,
  uzs,
} from './support';
import { buildSignedInitData, type FakeTelegramUser } from './telegram-init-data';

/**
 * Home page as a shopping surface: search, category rail, product grid with cart controls on the
 * cards, the header cart badge and the Telegram MainButton that replaces the web "go to cart" bar
 * inside the Mini App. Products are picked from the grid itself (first purchasable card), never by
 * seed name, so it survives catalog changes; only the price is read back from the API by slug.
 *
 * Authentication goes through the real Mini App path (see `support.ts`).
 */

// `data-stock="in"`: untracked or well stocked, so the stepper can go up to 2 (not "low" / "out").
// Its own customer: spec files run in parallel workers, and sharing the default E2E user would
// let the smoke spec's cart and this one's interfere.
const SHOPPER: FakeTelegramUser = { id: 900_000_031, first_name: 'Grid', language_code: 'uz' };

const PURCHASABLE_TILE = '[data-testid="product-tile"][data-stock="in"]';

test('add from the home grid, step the quantity, then continue to the cart', async ({ page }) => {
  const initData = buildSignedInitData({ botToken: requireBotToken(), user: SHOPPER });
  await installTelegramStub(page, initData);
  const cspViolations = await trackCspViolations(page);

  await emptyCart(page);
  await page.goto('/uz');

  // Home basics: a search field and category shortcuts above the grid.
  const search = page.getByRole('search', { name: 'Mahsulot qidirish' });
  await expect(search.getByRole('searchbox')).toBeVisible();
  await expect(page.locator('section nav ul a[href*="/uz/c/"]').first()).toBeVisible();

  // The first card that is comfortably in stock.
  const tile = page.locator(PURCHASABLE_TILE).first();
  await expect(tile).toBeVisible();
  const link = tile.getByRole('link');
  const name = (await link.getAttribute('title')) ?? '';
  expect(name).not.toBe('');
  const slug = new URL((await link.getAttribute('href')) ?? '', 'http://localhost').pathname
    .split('/')
    .pop();
  const apiProduct = (await (
    await page.request.get(`/api/v1/products/${encodeURIComponent(slug ?? '')}`)
  ).json()) as { price_uzs: number };

  // "Savatga" -> stepper at 1; the header badge follows the server's cart.
  const add = tile.getByRole('button', { name: `Savatga qo‘shish: ${name}` });
  await expect(add).toBeEnabled({ timeout: 15_000 });
  await add.click();
  const stepper = tile.getByRole('group', { name: `Miqdor: ${name}` });
  await expect(stepper.getByRole('status')).toHaveText('1');
  await expect(page.getByTestId('cart-count')).toHaveText('1');

  await stepper.getByRole('button', { name: `Ko‘paytirish: ${name}` }).click();
  await expect(stepper.getByRole('status')).toHaveText('2');
  await expect(page.getByTestId('cart-count')).toHaveText('2');

  // Inside Telegram the native MainButton is the "go to cart" control (the web bar is not drawn).
  await expect(page.getByTestId('cart-bar')).toHaveCount(0);
  await expect
    .poll(() => mainButton(page))
    .toMatchObject({ visible: true, text: expect.stringContaining(uzs(2 * apiProduct.price_uzs)) });

  // Going down to zero removes the line and brings "Savatga" back; add once more.
  await stepper.getByRole('button', { name: `Kamaytirish: ${name}` }).click();
  await expect(stepper.getByRole('status')).toHaveText('1');
  await stepper.getByRole('button', { name: `O‘chirish: ${name}` }).click();
  await expect(add).toBeVisible();
  await expect(page.getByTestId('cart-count')).toHaveCount(0);
  await add.click();
  await expect(stepper.getByRole('status')).toHaveText('1');
  await stepper.getByRole('button', { name: `Ko‘paytirish: ${name}` }).click();
  await expect(stepper.getByRole('status')).toHaveText('2');

  // MainButton opens the cart, which shows the same line with the server's total.
  await expect
    .poll(() => mainButton(page))
    .toMatchObject({ visible: true, text: expect.stringContaining(uzs(2 * apiProduct.price_uzs)) });
  expect(await pressMainButton(page)).toBe(true);
  await expect(page).toHaveURL(/\/uz\/cart$/);
  const line = page.getByTestId('cart-line').filter({ hasText: name });
  await expect(line).toBeVisible();
  await expect(line.getByRole('status')).toHaveText('2');
  await expect(page.getByTestId('cart-total')).toHaveText(uzs(2 * apiProduct.price_uzs));
  // The header badge agrees with the cart page.
  await expect(page.getByTestId('cart-count')).toHaveText('2');

  // Back on the home grid the card already shows the stepper at 2.
  await page.goto('/uz');
  await expect(
    page
      .getByRole('group', { name: `Miqdor: ${name}` })
      .first()
      .getByRole('status'),
  ).toHaveText('2', { timeout: 15_000 });

  await emptyCart(page);
  expect(await cspViolations()).toEqual([]);
});

test('sold-out cards cannot be added to the cart', async ({ page }) => {
  await page.route(/^https:\/\/([^/]+\.)?telegram\.org\//, (route) => route.abort());
  await page.goto('/uz');
  await expect(page.getByTestId('product-tile').first()).toBeVisible();
  const soldOut = page.locator('[data-testid="product-tile"][data-stock="out"]');
  // The dev seed has sold-out products; they may sit beyond the newest page, so only check when shown.
  if ((await soldOut.count()) > 0) {
    await expect(soldOut.first().getByRole('button')).toBeDisabled();
    await expect(soldOut.first().getByRole('button')).toHaveText('Tugagan');
  }
});

test('the home page fits a 320px phone: no sideways scroll, two equal columns', async ({
  page,
}) => {
  await page.route(/^https:\/\/([^/]+\.)?telegram\.org\//, (route) => route.abort());
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/uz');
  const tiles = page.getByTestId('product-tile');
  await expect(tiles.first()).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  const [first, second] = await Promise.all([
    tiles.nth(0).boundingBox(),
    tiles.nth(1).boundingBox(),
  ]);
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  // Same row, side by side, same width.
  expect(Math.abs((first?.y ?? 0) - (second?.y ?? 1))).toBeLessThan(1);
  expect((second?.x ?? 0) > (first?.x ?? 0) + (first?.width ?? 0) - 1).toBe(true);
  expect(Math.abs((first?.width ?? 0) - (second?.width ?? 1))).toBeLessThan(1);

  // The header keeps its controls at least 44px square.
  for (const name of ['Buyurtmalarim', /^Savat/]) {
    const box = await page.getByRole('banner').getByRole('link', { name }).boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  // Signed out, the wordmark and the header controls share one row (no wrapped second row).
  const wordmark = await page.getByRole('link', { name: /^MuniraMarket/ }).boundingBox();
  const cart = await page
    .getByRole('banner')
    .getByRole('link', { name: /^Savat/ })
    .boundingBox();
  expect(Math.abs((wordmark?.y ?? 0) - (cart?.y ?? 100))).toBeLessThan(4);
});
