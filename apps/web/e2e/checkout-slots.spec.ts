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
 * Selectors: a row of day chips (`role=tab`, `[data-testid="delivery-day-tab"]`, labelled "Yetkazish
 * kuni") picks the day; the shown day is the only `role=tabpanel` (`[data-day]`) and holds the radio
 * group named "Yetkazish vaqti". Each option is `[data-testid="delivery-slot-option"][data-slot-id]`
 * (the tile) around a native radio whose accessible name is "<day>, <dd.mm>, HH:MM–HH:MM". The other
 * days' windows stay in the DOM but are `visibility: hidden`, so role queries only see the shown day.
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

/** Opens the first day chip whose shown day offers at least `min` windows that can be booked. */
async function openDayWithWindows(page: Page, min: number): Promise<void> {
  const chips = page.getByRole('tab');
  const count = await chips.count();
  for (let index = 0; index < count; index += 1) {
    await chips.nth(index).click();
    const free = page.getByRole('tabpanel').getByRole('radio', { disabled: false });
    if ((await free.count()) >= min) return;
  }
  throw new Error(`No day offers ${String(min)} bookable windows`);
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
  // Only the shown day's windows are visible to role queries (the other days are hidden).
  const tiles = page.getByRole('tabpanel').getByTestId('delivery-slot-option');
  await expect(tiles.first()).toBeVisible();
  // Day chips: several days, the first one offered is today or tomorrow, by word.
  const chips = page.getByRole('tab');
  expect(await chips.count()).toBeGreaterThan(1);
  await expect(chips.first()).toContainText(/Bugun|Ertaga/);

  await fillOrderForm(page);

  // Valid form, no window: the MainButton stays disabled and the page says why.
  await expect.poll(() => mainButton(page)).toMatchObject({ visible: true, disabled: true });
  await expect(page.getByTestId('slot-reason')).toHaveText(
    'Buyurtma berish uchun yetkazish vaqtini tanlang.',
  );
  expect(await pressMainButton(page)).toBe(false);

  // Day chips: arrow keys and Home/End move focus along the row and show the day (roving tabindex).
  await page.getByRole('tab', { selected: true }).focus();
  const shownBefore = (await page.getByRole('tabpanel').getAttribute('data-day')) ?? '';
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { selected: true })).toBeFocused();
  await expect(page.getByRole('tabpanel')).not.toHaveAttribute('data-day', shownBefore);
  await page.keyboard.press('End');
  await expect(chips.last()).toHaveAttribute('aria-selected', 'true');
  await expect(chips.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(chips.first()).toHaveAttribute('aria-selected', 'true');
  await expect(chips.first()).toHaveAttribute('tabindex', '0');

  // A day with at least two windows to move between.
  await openDayWithWindows(page, 2);

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

  // Looking at another day does not touch the choice: the chip of the chosen day carries a check.
  const chosenChip = page.getByRole('tab', { selected: true });
  await expect(chosenChip.getByTestId('delivery-day-chosen')).toBeVisible();
  const otherChip = chips.nth((await chips.count()) - 1);
  if ((await otherChip.getAttribute('data-date')) !== day) {
    await otherChip.click();
    await expect(page.getByTestId('checkout-slot-summary')).toContainText(window);
    await expect(page.getByRole('radio', { checked: true })).toHaveCount(0);
    await page.locator(`[data-testid="delivery-day-tab"][data-date="${day ?? ''}"]`).click();
    await expect(chosenRadio).toBeChecked();
  }

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
  const tiles = page.getByRole('tabpanel').getByTestId('delivery-slot-option');
  await expect(tiles.first()).toBeVisible({ timeout: 15_000 });

  // No horizontal page scroll: only the row of day chips scrolls, and it is allowed to.
  const noPageScroll = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
  expect(await noPageScroll()).toBe(true);
  const row = page.getByTestId('delivery-day-row');
  const chips = page.getByRole('tab');
  for (const chip of await chips.all()) {
    // 44px+ touch targets, never shrunk or truncated.
    const box = await chip.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
  // Opening the last day scrolls the row (not the page) so its chip is fully in view.
  await chips.last().click();
  await expect(chips.last()).toHaveAttribute('aria-selected', 'true');
  expect(await noPageScroll()).toBe(true);
  const rowBox = await row.boundingBox();
  const lastBox = await chips.last().boundingBox();
  expect(lastBox?.x ?? 0).toBeGreaterThanOrEqual((rowBox?.x ?? 0) - 1);
  expect((lastBox?.x ?? 0) + (lastBox?.width ?? 0)).toBeLessThanOrEqual(
    (rowBox?.x ?? 0) + (rowBox?.width ?? 0) + 1,
  );
  // Switching days moves nothing below the picker: the card keeps its height.
  const cardHeight = async () => (await page.getByTestId('delivery-slots').boundingBox())?.height;
  const heightOnLastDay = await cardHeight();
  await chips.first().click();
  expect(await cardHeight()).toBe(heightOnLastDay);
  await openDayWithWindows(page, 2);
  expect(await cardHeight()).toBe(heightOnLastDay);

  // Every window is a comfortable touch target inside the card.
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
  // Two windows per row at 360px (the shown day has at least two).
  const first = await tiles.nth(0).boundingBox();
  const second = await tiles.nth(1).boundingBox();
  expect(Math.abs((first?.y ?? 0) - (second?.y ?? 99))).toBeLessThan(2);

  // Reduced motion collapses every transition and the entrance animation to (almost) nothing.
  const durations = await tiles.first().evaluate((element) => ({
    transition: getComputedStyle(element).transitionDuration,
    chip: getComputedStyle(document.querySelector('[role="tab"]') as Element).transitionDuration,
    section: getComputedStyle(element.closest('section') as Element).animationDuration,
  }));
  expect(Number.parseFloat(durations.transition)).toBeLessThan(0.001);
  expect(Number.parseFloat(durations.chip)).toBeLessThan(0.001);
  expect(Number.parseFloat(durations.section)).toBeLessThan(0.001);

  await emptyCart(page);
});
