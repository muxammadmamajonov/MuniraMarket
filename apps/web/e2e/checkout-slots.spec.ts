import { expect, test, type Page } from '@playwright/test';
import {
  emptyCart,
  installTelegramStub,
  mainButton,
  pressMainButton,
  requireBotToken,
  trackCspViolations,
} from './support';
import { buildSignedInitData, type FakeTelegramUser } from './telegram-init-data';

/**
 * Delivery-time selection. The seed gives only zone `demo-chekka` (districts chilonzor, olmazor,
 * uchtepa, yashnobod) delivery slots; the zone of `yunusobod`, used by checkout.spec.ts, has none
 * and keeps the slot-less flow. A zone with slots needs a window before an order can be placed.
 *
 * Selectors: the radio group is named "Yetkazish vaqti"; each option is
 * `[data-testid="delivery-slot-option"][data-slot-id]` (the tile) around a native radio whose
 * accessible name is "<day>, <dd.mm>, HH:MM–HH:MM".
 */

const ORDER_URL = /\/uz\/orders\/[0-9a-f-]{36}\?placed=1$/;

const WHO: FakeTelegramUser = {
  id: 900_000_011,
  first_name: 'Slot',
  last_name: 'Tester',
  username: 'e2e_slots',
  language_code: 'uz',
};

async function signIn(page: Page): Promise<() => Promise<string[]>> {
  await installTelegramStub(page, buildSignedInitData({ botToken: requireBotToken(), user: WHO }));
  return trackCspViolations(page);
}

async function addToCart(page: Page, slug: string, quantity: number): Promise<void> {
  await page.goto(`/uz/p/${slug}`);
  const add = page.getByRole('button', { name: 'Savatga qo‘shish' });
  await expect(add).toBeEnabled({ timeout: 15_000 });
  for (let value = 1; value < quantity; value += 1) {
    await page.getByRole('button', { name: 'Ko‘paytirish' }).click();
  }
  await expect(page.getByRole('status').filter({ hasText: String(quantity) })).toBeVisible();
  await add.click();
  await expect(page.getByTestId('added-message')).toBeVisible();
}

async function fillOrderForm(page: Page): Promise<void> {
  await page.getByLabel('Ko‘cha').fill('Demo ko‘cha');
  await page.getByLabel('Uy', { exact: true }).fill('12');
  await page.getByLabel('Telefon raqami').fill('+998 00 123-45-67');
  await page.getByRole('radio', { name: 'Yetkazilganda naqd pul' }).check();
}

test('book a delivery window: picker, MainButton gate, keyboard, order page shows the window', async ({
  page,
}) => {
  const cspViolations = await signIn(page);

  await emptyCart(page);
  // 8 kg clear the 100 000 minimum of the slot zone at any seed price of 15 000 per kg.
  await addToCart(page, 'demo-olma', 8);
  await page.goto('/uz/checkout');

  const district = page.getByLabel('Tuman');
  await expect(district).toBeVisible({ timeout: 15_000 });

  // A zone without slots shows no picker.
  await district.selectOption('yunusobod');
  await expect(page.getByTestId('checkout-total')).not.toHaveText('—');
  await expect(page.getByTestId('delivery-slots')).toHaveCount(0);

  // A zone with slots does, once its quote arrives.
  await district.selectOption('chilonzor');
  const group = page.getByRole('radiogroup', { name: 'Yetkazish vaqti' });
  await expect(group).toBeVisible();
  const tiles = page.getByTestId('delivery-slot-option');
  await expect(tiles.first()).toBeVisible();
  expect(await tiles.count()).toBeGreaterThan(1);
  // Day headings: the first offered day is today or tomorrow, by word.
  await expect(page.locator('[data-day]').first()).toContainText(/Bugun|Ertaga/);

  await fillOrderForm(page);

  // Valid form, no window: the MainButton stays disabled and the page says why.
  await expect.poll(() => mainButton(page)).toMatchObject({ visible: true, disabled: true });
  await expect(page.getByTestId('slot-reason')).toHaveText(
    'Buyurtma berish uchun yetkazish vaqtini tanlang.',
  );
  expect(await pressMainButton(page)).toBe(false);

  // Real keyboard behaviour: Tab/arrow keys move through the enabled windows and select them.
  const enabled = group.getByRole('radio', { disabled: false });
  const enabledCount = await enabled.count();
  expect(enabledCount).toBeGreaterThan(1);
  await enabled.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(enabled.nth(1)).toBeChecked();
  await expect(group.getByRole('radio', { checked: true })).toHaveCount(1);
  await page.keyboard.press('ArrowLeft');
  await expect(enabled.first()).toBeChecked();
  // Arrow keys never land on a window that is full (disabled radios are skipped).
  for (const full of await group.getByRole('radio', { disabled: true }).all()) {
    await expect(full).not.toBeChecked();
  }

  // Choose the second window by tapping its tile.
  const chosenTile = tiles.filter({ has: page.getByRole('radio', { disabled: false }) }).nth(1);
  await chosenTile.click();
  const chosenRadio = chosenTile.getByRole('radio');
  await expect(chosenRadio).toBeChecked();
  const label = (await chosenRadio.getAttribute('aria-label')) ?? '';
  const window = label.split(', ').at(-1) ?? '';
  expect(window).toMatch(/^\d\d:\d\d–\d\d:\d\d$/);
  const day = await chosenTile.locator('xpath=ancestor::*[@data-day][1]').getAttribute('data-day');
  expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const [year, month, dayOfMonth] = (day ?? '').split('-');
  const expectedWhen = `${dayOfMonth}.${month}.${year}, ${window}`;

  await expect(page.getByTestId('checkout-slot-summary')).toContainText(window);
  await expect.poll(() => mainButton(page)).toMatchObject({ visible: true, disabled: false });
  await expect(page.getByTestId('slot-reason')).toHaveCount(0);

  // The request carries the chosen slot id.
  const slotId = await chosenTile.getAttribute('data-slot-id');
  const posted = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/api/v1/orders'),
  );
  expect(await pressMainButton(page)).toBe(true);
  expect((await posted).postDataJSON()).toMatchObject({ delivery_slot_id: slotId });
  await expect(page).toHaveURL(ORDER_URL, { timeout: 20_000 });

  // The order page shows the booked window next to the address.
  await expect(page.getByTestId('placed-banner')).toBeVisible();
  await expect(page.getByTestId('order-slot')).toContainText(expectedWhen);
  await expect(page.getByRole('region', { name: 'Yetkazib berish manzili' })).toContainText(
    'Chilonzor',
  );

  // Reload: the window is part of the stored order, not of the redirect.
  await page.goto(page.url().replace('?placed=1', ''));
  await expect(page.getByTestId('order-slot')).toContainText(expectedWhen);

  // Cancel it so the demo capacity is released for the next run.
  await page.getByTestId('cancel-order').click();
  const dialog = page.getByRole('dialog', { name: 'Buyurtmani bekor qilasizmi?' });
  await dialog.getByRole('button', { name: 'Xato buyurtma berdim' }).click();
  await dialog.getByRole('button', { name: 'Bekor qilish', exact: true }).click();
  await expect(page.getByTestId('cancelled-notice')).toBeVisible();

  expect(await cspViolations()).toEqual([]);
});

test('the picker fits a 360px screen and honours prefers-reduced-motion', async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 360, height: 740 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await emptyCart(page);
  await addToCart(page, 'demo-olma', 8);
  await page.goto('/uz/checkout');
  await page.getByLabel('Tuman').selectOption('chilonzor');
  const tiles = page.getByTestId('delivery-slot-option');
  await expect(tiles.first()).toBeVisible({ timeout: 15_000 });

  // No horizontal page scroll, and every window is a comfortable touch target inside the card.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  const card = await page.getByTestId('delivery-slots').boundingBox();
  for (const tile of await tiles.all()) {
    const box = await tile.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
      (card?.x ?? 0) + (card?.width ?? 0),
    );
  }
  // Two windows per row at 360px (today may have only one left, so look at the second day).
  const pair = page.locator('[data-day]').nth(1).getByTestId('delivery-slot-option');
  const first = await pair.nth(0).boundingBox();
  const second = await pair.nth(1).boundingBox();
  expect(Math.abs((first?.y ?? 0) - (second?.y ?? 99))).toBeLessThan(2);

  // Reduced motion collapses every transition and the entrance animation to (almost) nothing.
  const durations = await tiles.first().evaluate((element) => ({
    transition: getComputedStyle(element).transitionDuration,
    section: getComputedStyle(element.closest('section') as Element).animationDuration,
  }));
  expect(Number.parseFloat(durations.transition)).toBeLessThan(0.001);
  expect(Number.parseFloat(durations.section)).toBeLessThan(0.001);

  await emptyCart(page);
});
