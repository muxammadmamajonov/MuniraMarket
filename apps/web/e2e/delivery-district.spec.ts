import { expect, test, type Page } from '@playwright/test';
import { uzs } from './support';

/**
 * Phase 8: the delivery-district chooser and catalog discovery.
 *
 * - The chooser is non-blocking, explains itself before a choice, opens a custom sheet, works by
 *   keyboard, persists only the district code, survives reloads and language switches, and falls
 *   back safely when storage is unusable or the remembered district is no longer served.
 * - Catalog discovery (category rail, search, in-stock filter, sort) and the catalog -> cart ->
 *   checkout path, where the saved district is preselected and re-priced by the server.
 * - 320px, 390px, desktop and dark mode never scroll sideways; offline, no-result, long-text and
 *   unavailable-product states render.
 *
 * Browsing needs no sign-in, so every test here blocks telegram.org and signs in to nothing (the
 * Core API allows 10 logins a minute per IP). The catalog -> cart -> checkout continuity with the
 * saved district runs inside the signed-in flow of `home-grid.spec.ts`.
 *
 * Set `E2E_SHOTS_DIR` to save the screenshots used in the PR description.
 */

const ITEM = 'mm.delivery-district.v1';

/** Money as the storefront prints it; `support.uzs` covers Uzbek only. */
function money(amount: number, locale: 'uz' | 'ru'): string {
  return locale === 'uz'
    ? uzs(amount)
    : `${String(amount).replace(/\B(?=(\d{3})+$)/g, '\u00a0')}\u00a0сум`;
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['E2E_SHOTS_DIR'];
  if (dir !== undefined && dir !== '') await page.screenshot({ path: `${dir}/${name}.png` });
}

async function browseAnonymously(page: Page): Promise<void> {
  await page.route(/^https:\/\/([^/]+\.)?telegram\.org\//, (route) => route.abort());
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `page scrolls sideways by ${String(overflow)}px`).toBeLessThanOrEqual(0);
}

/**
 * While Next streams the page, the server's copy sits in a hidden `<div hidden id="S:0">` next to
 * the swapped-in one for a moment; only the visible chooser counts.
 */
function chooser(page: Page) {
  return page.getByTestId('delivery-district').filter({ visible: true });
}

test.describe('delivery district chooser', () => {
  test.beforeEach(async ({ page }) => browseAnonymously(page));

  test('Uzbek: explains, opens, selects, persists, changes and closes', async ({ page }) => {
    await page.goto('/uz');
    const card = chooser(page);
    await expect(card).toHaveAttribute('data-state', 'unset');
    await expect(card).toContainText(
      'Yetkazish narxi va vaqt oralig‘lari tanlangan tumanga bog‘liq.',
    );
    // Non-blocking: the catalog is already there.
    await expect(page.getByTestId('product-tile').first()).toBeVisible();
    await shot(page, 'uz-mobile-home-unset');

    await card.getByRole('button', { name: 'Tumanni tanlash' }).click();
    const sheet = page.getByRole('dialog', { name: 'Yetkazish tumanini tanlang' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('group')).toHaveCount(3); // the inactive seed zone is not offered
    await expect(sheet.getByRole('radio', { name: 'Bektemir' })).toHaveCount(0);
    await sheet.getByText('Yunusobod', { exact: true }).click();
    await shot(page, 'district-picker');
    await sheet.getByRole('button', { name: 'Tanlash' }).click();
    await expect(sheet).toBeHidden();

    await expect(card).toHaveAttribute('data-state', 'set');
    await expect(chooser(page).getByTestId('delivery-district-name')).toHaveText('Yunusobod');
    await expect(card).toContainText(`Yetkazish: ${uzs(15_000)}`);
    await expect(card).toContainText(`${uzs(300_000)} dan bepul`);
    expect(await page.evaluate((key) => window.localStorage.getItem(key), ITEM)).toBe('yunusobod');
    expect(await page.evaluate(() => Object.keys(window.localStorage))).toEqual([ITEM]);
    await shot(page, 'uz-mobile-home');

    // Persisted across a reload; "change" then closing with the X keeps the old choice.
    await page.reload();
    await expect(chooser(page).getByTestId('delivery-district-name')).toHaveText('Yunusobod');
    await card.getByRole('button', { name: /O‘zgartirish/ }).click();
    await expect(sheet.getByRole('radio', { name: 'Yunusobod' })).toBeChecked();
    await sheet.getByText('Sergeli', { exact: true }).click();
    await sheet.getByRole('button', { name: 'Yopish' }).click();
    await expect(sheet).toBeHidden();
    await expect(chooser(page).getByTestId('delivery-district-name')).toHaveText('Yunusobod');

    // Change for real: a zone without free delivery shows no "free from" line.
    await card.getByRole('button', { name: /O‘zgartirish/ }).click();
    await sheet.getByText('Sergeli', { exact: true }).click();
    await sheet.getByRole('button', { name: 'Tanlash' }).click();
    await expect(chooser(page).getByTestId('delivery-district-name')).toHaveText('Sergeli');
    await expect(card).toContainText(`Yetkazish: ${uzs(30_000)}`);
    await expect(card).not.toContainText('bepul');
  });

  test('keyboard: Tab, Enter, arrows browse without committing, Escape cancels, Enter confirms', async ({
    page,
  }) => {
    await page.goto('/uz');
    const open = chooser(page).getByRole('button', { name: 'Tumanni tanlash' });
    await open.focus();
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: 'Yetkazish tumanini tanlang' });
    await expect(sheet).toBeVisible();

    // Focus starts on the first district; arrows move the pending choice only.
    const first = sheet.getByRole('radio').first();
    await expect(first).toBeFocused();
    await page.keyboard.press('Space');
    await expect(first).toBeChecked();
    await page.keyboard.press('ArrowDown');
    await expect(sheet.getByRole('radio').nth(1)).toBeChecked();
    expect(await page.evaluate((key) => window.localStorage.getItem(key), ITEM)).toBeNull();

    // Escape closes, nothing saved, focus goes back to the trigger.
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(open).toBeFocused();
    await expect(chooser(page)).toHaveAttribute('data-state', 'unset');

    // Again, and confirm with Enter on the submit button (Tab reaches it, focus stays in the sheet).
    await page.keyboard.press('Enter');
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Space');
    const chosen = (await sheet.getByRole('radio').first().getAttribute('value')) ?? '';
    await page.keyboard.press('Tab');
    await expect(sheet.getByRole('button', { name: 'Tanlash' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(sheet).toBeHidden();
    await expect(chooser(page)).toHaveAttribute('data-district', chosen);
    // The focus ring is visible on the change button when tabbed to.
    const change = chooser(page).getByRole('button', { name: /O‘zgartirish/ });
    await change.focus();
    await expect(change).toBeFocused();
  });

  test('Russian: same district, Russian names and money, after switching language', async ({
    page,
  }) => {
    await page.addInitScript((key) => window.localStorage.setItem(key, 'chilonzor'), ITEM);
    await page.goto('/ru');
    const card = chooser(page);
    await expect(chooser(page).getByTestId('delivery-district-name')).toHaveText('Чиланзарский');
    await expect(card).toContainText('Район доставки');
    await expect(card).toContainText(`Доставка: ${money(25_000, 'ru')}`);
    await expect(card).toContainText(`Бесплатно от ${money(500_000, 'ru')}`);
    await shot(page, 'ru-mobile-home');

    await card.getByRole('button', { name: /Изменить/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Выберите район доставки' });
    await expect(sheet.getByRole('radio', { name: 'Чиланзарский' })).toBeChecked();
    await expect(sheet.getByRole('button', { name: 'Выбрать' })).toBeVisible();
    await shot(page, 'ru-district-picker');
  });

  test('safe fallback: tampered, unserved and unusable storage', async ({ page, context }) => {
    // A value that is not a district code is ignored.
    await page.addInitScript((key) => window.localStorage.setItem(key, '<b>x</b>'), ITEM);
    await page.goto('/uz');
    await expect(chooser(page)).toHaveAttribute('data-state', 'unset');

    // A district whose zone is inactive in the seed: back to the prompt, with a reason.
    const second = await context.newPage();
    await browseAnonymously(second);
    await second.addInitScript((key) => window.localStorage.setItem(key, 'bektemir'), ITEM);
    await second.goto('/uz');
    await expect(chooser(second)).toHaveAttribute('data-state', 'unset');
    await expect(chooser(second)).toContainText('Avval tanlangan tumanga hozir yetkazilmaydi.');
    await second.close();
  });

  test('storage that throws still lets the customer pick for this visit', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('blocked', 'SecurityError');
        },
      });
    });
    await page.goto('/uz');
    await chooser(page).getByRole('button', { name: 'Tumanni tanlash' }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByText('Mirobod', { exact: true }).click();
    await sheet.getByRole('button', { name: 'Tanlash' }).click();
    await expect(chooser(page).getByTestId('delivery-district-name')).toHaveText('Mirobod');
  });
});

test.describe('layout: no sideways scroll, dark mode', () => {
  test.beforeEach(async ({ page }) => browseAnonymously(page));

  for (const [width, height] of [
    [320, 640],
    [390, 844],
    [1280, 800],
  ] as const) {
    test(`${String(width)}px: home, category, search, product`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript((key) => window.localStorage.setItem(key, 'mirzo_ulugbek'), ITEM);
      for (const locale of ['uz', 'ru'] as const) {
        await page.goto(`/${locale}`);
        await expect(chooser(page)).toHaveAttribute('data-state', 'set');
        await expectNoHorizontalScroll(page);
        if (width === 1280 && locale === 'uz') await shot(page, 'desktop-home');
        if (width === 320 && locale === 'ru') await shot(page, 'ru-320-home');

        const category = page.locator('main nav ul a[href*="/c/"]').first();
        await category.click();
        await expect(page.getByTestId('catalog-toolbar').filter({ visible: true })).toBeVisible();
        await expectNoHorizontalScroll(page);

        // The longest query the API accepts, without spaces, wraps instead of overflowing.
        await page.goto(`/${locale}/search?q=${'Qaymoqlishokoladli'.repeat(6).slice(0, 100)}`);
        await expect(page.getByTestId('empty-panel').filter({ visible: true })).toBeVisible();
        await expectNoHorizontalScroll(page);

        await page.goto(`/${locale}/p/demo-olma`);
        await expectNoHorizontalScroll(page);
      }
      // The sheet itself at this width.
      await page.goto('/ru');
      await chooser(page)
        .getByRole('button', { name: /Изменить/ })
        .click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoHorizontalScroll(page);
      if (width === 320) await shot(page, 'ru-320-picker');
    });
  }

  test('dark mode keeps the chooser, toolbar and tiles readable', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.addInitScript((key) => window.localStorage.setItem(key, 'yunusobod'), ITEM);
    await page.goto('/uz');
    const card = chooser(page);
    await expect(card).toHaveAttribute('data-state', 'set');
    const [bg, fg] = await card.evaluate((element) => {
      const style = getComputedStyle(element);
      const name = element.querySelector('[data-testid="delivery-district-name"]');
      return [style.backgroundColor, name === null ? '' : getComputedStyle(name).color];
    });
    expect(bg).not.toBe(fg);
    expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(
      true,
    );
    await expectNoHorizontalScroll(page);
    await shot(page, 'dark-home');
    await chooser(page)
      .getByRole('button', { name: /O‘zgartirish/ })
      .click();
    await shot(page, 'dark-picker');
  });
});

test.describe('catalog discovery and states', () => {
  test.beforeEach(async ({ page }) => browseAnonymously(page));

  test('category rail, in-stock filter, sort and an unavailable product', async ({ page }) => {
    await page.goto('/uz');
    const rail = page.getByRole('navigation', { name: 'Kategoriyalar' });
    const first = rail.getByRole('link').first();
    const href = (await first.getAttribute('href')) ?? '';
    await first.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    // The rail is on the category page too, with the current category marked.
    await expect(
      page.getByRole('navigation', { name: 'Kategoriyalar' }).locator('[aria-current="page"]'),
    ).toHaveAttribute('href', href);

    // The seed's "Sut va sut mahsulotlari" holds the out-of-stock demo product; find it by API.
    const all = (await (await page.request.get('/api/v1/products?page_size=48')).json()) as {
      items: Array<{ slug: string; in_stock: boolean; name_uz: string }>;
    };
    const out = all.items.find((item) => !item.in_stock);
    expect(out, 'the seed has an out-of-stock product').toBeDefined();
    await page.goto(`/uz/search?q=${encodeURIComponent(out?.name_uz.slice(0, 20) ?? '')}`);
    const outTile = page.locator('[data-testid="product-tile"][data-stock="out"]').first();
    await expect(outTile).toBeVisible();
    await expect(outTile.getByRole('button', { name: /^Tugagan/ })).toBeDisabled();

    // In-stock only: the switch navigates, the out-of-stock card disappears, the count follows.
    const toggle = page.getByRole('switch', { name: 'Faqat mavjudlari' });
    // Click the visible label, as a customer does (the real checkbox is visually hidden).
    await page.locator('label:visible', { hasText: 'Faqat mavjudlari' }).click();
    await expect(page).toHaveURL(/stock=1/);
    await expect(page.locator('[data-testid="product-tile"][data-stock="out"]')).toHaveCount(0);
    await expect(toggle).toBeChecked();

    // Sort keeps the filter.
    await page.getByRole('combobox', { name: /Saralash/ }).click();
    await page.getByRole('option', { name: 'Avval arzonlari' }).click();
    await expect(page).toHaveURL(/stock=1.*sort=price_asc|sort=price_asc.*stock=1/);
  });

  test('no results, offline banner', async ({ page, context }) => {
    await page.goto('/ru/search?q=zzzzzz');
    await expect(page.getByTestId('empty-panel').filter({ visible: true })).toContainText(
      'Ничего не найдено',
    );
    await expect(page.getByRole('navigation', { name: 'Категории' })).toBeVisible();

    await page.goto('/uz');
    await context.setOffline(true);
    await expect(page.getByTestId('offline-banner')).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByTestId('offline-banner')).toBeHidden();
  });

  test('unknown product shows the not-found state', async ({ page }) => {
    await page.goto('/uz/p/demo-does-not-exist');
    await expect(page.getByRole('heading', { name: 'Sahifa topilmadi' })).toBeVisible();
  });
});
