import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  emptyCart,
  installTelegramStub,
  mainButton,
  pressMainButton,
  requireBotToken,
  seedDeliveryAddress,
} from './support';
import { buildSignedInitData } from './telegram-init-data';

/**
 * Visual capture, not a test: screenshots every customer page at 390x844 and 320x700, light and
 * dark, inside a simulated Telegram fullscreen (status bar 47px + Close/"…" row 46px). Skipped
 * unless `E2E_VISUAL_DIR` names an output folder, so CI never signs in for it.
 *
 *   E2E_VISUAL_DIR=/tmp/shots/after E2E_TELEGRAM_BOT_TOKEN=... pnpm exec playwright test visual-capture
 */
const OUT = process.env['E2E_VISUAL_DIR'] ?? '';
const ONLY = (process.env['E2E_VISUAL_ONLY'] ?? '').split(',').filter(Boolean);

test.skip(OUT === '', 'set E2E_VISUAL_DIR to capture screenshots');
test.setTimeout(600_000);

const SIZES = [
  { name: '390', width: 390, height: 844 },
  { name: '320', width: 320, height: 700 },
] as const;
const SCHEMES = ['light', 'dark'] as const;

async function fullscreen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.documentElement;
    // The Next dev overlay badge is not part of the app.
    for (const portal of document.querySelectorAll('nextjs-portal')) portal.remove();
    root.setAttribute('data-tg-fullscreen', '');
    root.style.setProperty('--mm-tg-safe-top', '47px');
    root.style.setProperty('--mm-tg-content-top', '46px');
    root.style.setProperty('--mm-tg-safe-bottom', '34px');
  });
}

async function addFromProductPage(page: Page, slug: string, times: number): Promise<void> {
  await page.goto(`/uz/p/${slug}`);
  const add = page.getByRole('button', { name: 'Savatga qo‘shish' });
  await expect(add).toBeEnabled({ timeout: 15_000 });
  for (let i = 1; i < times; i += 1) {
    await page.getByRole('button', { name: 'Ko‘paytirish' }).click();
  }
  await add.click();
  await expect(page.getByTestId('added-message')).toBeVisible();
}

test('capture every customer page', async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await installTelegramStub(
    page,
    buildSignedInitData({
      botToken: requireBotToken(),
      user: { id: 900_000_077, first_name: 'Dilnoza', last_name: 'Karimova', language_code: 'uz' },
    }),
  );

  // A customer who already saved a delivery address (the home card and checkout show it).
  await seedDeliveryAddress(page);

  const categories = (await (await page.request.get('/api/v1/categories')).json()) as {
    items: Array<{ slug: string; children: Array<{ slug: string }> }>;
  };
  const categorySlug = categories.items[0]?.children[0]?.slug ?? categories.items[0]?.slug ?? '';

  // An order for the history pages, then a fresh cart for cart/checkout.
  await emptyCart(page);
  let orderUrl = '';
  const existing = (await (await page.request.get('/api/v1/orders')).json()) as {
    items?: Array<{ id: string }>;
  };
  if ((existing.items ?? []).length === 0) {
    await addFromProductPage(page, 'demo-olma', 4);
    await page.goto('/uz/checkout');
    await expect(page.getByTestId('checkout-address')).toBeVisible({ timeout: 15_000 });
    await page.getByLabel('Telefon raqami').fill('+998 00 123-45-67');
    await page.locator('label', { hasText: 'Yetkazilganda naqd pul' }).click();
    await expect.poll(() => mainButton(page)).toMatchObject({ visible: true, disabled: false });
    await pressMainButton(page);
    await expect(page).toHaveURL(/\/uz\/orders\/[0-9a-f-]{36}/, { timeout: 20_000 });
    orderUrl = new URL(page.url()).pathname;
  } else {
    orderUrl = `/uz/orders/${existing.items?.[0]?.id ?? ''}`;
  }

  const pages: Array<{ key: string; path: string }> = [{ key: 'cart-empty', path: '/uz/cart' }];
  const filledPages: Array<{ key: string; path: string }> = [
    { key: 'home', path: '/uz' },
    { key: 'catalog', path: '/uz/catalog' },
    { key: 'category', path: `/uz/c/${categorySlug}` },
    { key: 'search', path: '/uz/search?q=olma' },
    { key: 'search-empty', path: '/uz/search?q=zzzzqqq' },
    { key: 'product', path: '/uz/p/demo-olma' },
    { key: 'cart', path: '/uz/cart' },
    { key: 'checkout', path: '/uz/checkout' },
    { key: 'orders', path: '/uz/orders' },
    { key: 'order', path: orderUrl },
    { key: 'profile', path: '/uz/profile' },
    { key: 'notfound', path: '/uz/nope-404' },
  ];

  const shoot = async (list: Array<{ key: string; path: string }>) => {
    for (const { key, path } of list) {
      if (ONLY.length > 0 && !ONLY.includes(key)) continue;
      for (const size of SIZES) {
        await page.setViewportSize({ width: size.width, height: size.height });
        for (const scheme of SCHEMES) {
          await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
          await page.goto(path);
          await page.waitForLoadState('networkidle');
          await fullscreen(page);
          await page.waitForTimeout(250);
          await page.screenshot({
            path: join(OUT, `${key}-${size.name}-${scheme}.png`),
            fullPage: true,
          });
        }
      }
    }
  };

  await shoot(pages);
  await addFromProductPage(page, 'demo-olma', 2);
  await addFromProductPage(page, 'demo-qora-choy', 1);
  await shoot(filledPages);
});
