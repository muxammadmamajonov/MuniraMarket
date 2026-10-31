import { expect, test, type Page } from '@playwright/test';
import {
  emptyCart,
  installTelegramStub,
  mainButton,
  newAdminContext,
  pressMainButton,
  requireBotToken,
  signInToAdmin,
  trackConsoleCsp,
  trackCspViolations,
} from './support';
import { buildSignedInitData, type FakeTelegramUser } from './telegram-init-data';

/**
 * Zone/slot setup -> checkout slot selection.
 *
 * An admin signs in to the admin app (Telegram Login Widget redirect, see `signInToAdmin`), opens
 * Delivery -> Slots and creates a delivery slot for the active seed zone `demo-chekka`
 * (districts chilonzor, olmazor, uchtepa, yashnobod). A customer (Mini App stub) then adds
 * products to the cart, checks out to a district of that zone, picks exactly that slot, places the
 * order and sees the booked window on the order page. Back in the admin the slot shows one booking,
 * and none after the order is cancelled; the slot is then deactivated so it is no longer offered.
 *
 * Unique window per run: a date 3-5 days ahead and a random start time (minutes never :00, so it
 * cannot collide with the seeded 10:00 and 15:00 windows), so reruns never hit `slot_exists`.
 *
 * A slot that an order referenced cannot be deleted (it keeps its history), hence deactivation.
 */

const ORDER_URL = /\/uz\/orders\/[0-9a-f-]{36}\?placed=1$/;
const ZONE_NAME_UZ = 'Demo chekka zona';
const DISTRICT = 'uchtepa';
const DISTRICT_NAME_UZ = 'Uchtepa';

const CUSTOMER: FakeTelegramUser = {
  id: 900_000_021,
  first_name: 'Admin',
  last_name: 'Slot Customer',
  username: 'e2e_admin_slots',
  language_code: 'uz',
};

const two = (value: number) => String(value).padStart(2, '0');

/** Today's date in Asia/Tashkent (what the API and the admin call "today") plus `days`, as YYYY-MM-DD. */
function tashkentDatePlus(days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tashkent',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${two(shifted.getUTCMonth() + 1)}-${two(shifted.getUTCDate())}`;
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
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

test('admin creates a delivery slot and a customer books exactly that window at checkout', async ({
  page: storefront,
  browser,
}) => {
  const slotDate = tashkentDatePlus(randomInt(3, 5));
  const startHour = randomInt(9, 16);
  const startMinute = randomInt(1, 59);
  const startsAt = `${two(startHour)}:${two(startMinute)}`;
  // 30 minutes long: at most 16:59 -> 17:29, inside the zone's 09:00-20:00 hours.
  const endTotal = startHour * 60 + startMinute + 30;
  const endsAt = `${two(Math.floor(endTotal / 60))}:${two(endTotal % 60)}`;
  const windowText = `${startsAt}–${endsAt}`;
  const [year, month, day] = slotDate.split('-') as [string, string, string];
  const expectedWhen = `${day}.${month}.${year}, ${windowText}`;
  const capacity = 5;

  // --- Admin: sign in with the Login Widget and create the slot -------------------------------
  const adminContext = await newAdminContext(browser);
  const admin = await adminContext.newPage();
  const adminCsp = await trackCspViolations(admin);
  const consoleCsp = trackConsoleCsp(admin);

  try {
    await signInToAdmin(admin);

    await admin.getByTestId('nav-slots').click();
    await expect(admin).toHaveURL(/\/uz\/delivery\/slots$/);
    await expect(admin.getByTestId('new-slot')).toBeEnabled({ timeout: 15_000 });
    await admin.getByTestId('new-slot').click();

    const dialog = admin.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('slot-zone').selectOption({ label: ZONE_NAME_UZ });
    await dialog.getByTestId('slot-date').fill(slotDate);
    await dialog.getByTestId('slot-starts-at').fill(startsAt);
    await dialog.getByTestId('slot-ends-at').fill(endsAt);
    await dialog.getByTestId('slot-capacity').fill(String(capacity));
    // The cut-off keeps its default (two hours before the start).
    const created = admin.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/admin/delivery/slots',
    );
    await dialog.getByTestId('slot-create').click();
    const createdResponse = await created;
    expect(createdResponse.status(), 'slot_exists would mean the window was not unique').toBe(201);
    const slotId = ((await createdResponse.json()) as { id: string }).id;
    await expect(admin.getByRole('status').filter({ hasText: 'Oraliq yaratildi.' })).toBeVisible();
    await expect(dialog).toHaveCount(0);

    const slotRow = admin.getByTestId('slot-row').filter({ hasText: windowText });
    await expect(slotRow).toHaveCount(1);
    await expect(slotRow).toContainText(ZONE_NAME_UZ);
    await expect(slotRow).toContainText(`Band: 0 / ${capacity}`);

    // --- Customer: add products, check out to the zone, choose the admin's slot ---------------
    await installTelegramStub(
      storefront,
      buildSignedInitData({ botToken: requireBotToken(), user: CUSTOMER }),
    );
    const storefrontCsp = await trackCspViolations(storefront);
    trackConsoleCsp(storefront, consoleCsp);

    // Two products: 4 kg apples + 2 kg grapes clear the zone's 100 000 minimum at seed prices.
    const priceOf = async (slug: string): Promise<number> => {
      const response = await storefront.request.get(`/api/v1/products/${slug}`);
      expect(response.ok()).toBe(true);
      return ((await response.json()) as { price_uzs: number }).price_uzs;
    };
    const subtotal = 4 * (await priceOf('demo-olma')) + 2 * (await priceOf('demo-uzum'));
    expect(
      subtotal,
      'seed prices changed: the cart must clear the zone minimum',
    ).toBeGreaterThanOrEqual(100_000);
    await emptyCart(storefront);
    await addToCart(storefront, 'demo-olma', 4);
    await addToCart(storefront, 'demo-uzum', 2);

    await storefront.goto('/uz/checkout');
    const district = storefront.getByLabel('Tuman');
    await expect(district).toBeVisible({ timeout: 15_000 });
    await district.selectOption(DISTRICT);

    const group = storefront.getByRole('radiogroup', { name: 'Yetkazish vaqti' });
    await expect(group).toBeVisible();
    // The new window is on its own day: open that day's chip, then it is offered, not full and
    // not yet chosen.
    await storefront.locator(`[data-testid="delivery-day-tab"][data-date="${slotDate}"]`).click();
    const tile = storefront
      .locator(`[data-day="${slotDate}"]`)
      .getByTestId('delivery-slot-option')
      .filter({ has: storefront.getByRole('radio', { name: new RegExp(`${windowText}$`) }) });
    await expect(tile).toHaveCount(1);
    await expect(tile).toHaveAttribute('data-slot-id', slotId);
    await expect(tile.getByRole('radio')).toBeEnabled();
    await expect(tile.getByRole('radio')).not.toBeChecked();

    await storefront.getByLabel('Ko‘cha').fill('Demo ko‘cha');
    await storefront.getByLabel('Uy', { exact: true }).fill('12');
    await storefront.getByLabel('Telefon raqami').fill('+998 00 123-45-67');
    await storefront.getByRole('radio', { name: 'Yetkazilganda naqd pul' }).check();

    // Valid form but no window yet: the native MainButton stays disabled.
    await expect
      .poll(() => mainButton(storefront))
      .toMatchObject({ visible: true, disabled: true });

    await tile.click();
    await expect(tile.getByRole('radio')).toBeChecked();
    await expect(storefront.getByTestId('checkout-slot-summary')).toContainText(windowText);
    await expect
      .poll(() => mainButton(storefront))
      .toMatchObject({ visible: true, disabled: false });

    const posted = storefront.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/api/v1/orders'),
    );
    expect(await pressMainButton(storefront)).toBe(true);
    expect((await posted).postDataJSON()).toMatchObject({ delivery_slot_id: slotId });
    await expect(storefront).toHaveURL(ORDER_URL, { timeout: 20_000 });

    // The order page shows the booked window next to the address, also after a reload.
    await expect(storefront.getByTestId('placed-banner')).toBeVisible();
    await expect(storefront.getByTestId('order-slot')).toContainText(expectedWhen);
    await expect(storefront.getByRole('region', { name: 'Yetkazib berish manzili' })).toContainText(
      DISTRICT_NAME_UZ,
    );
    const orderUrl = storefront.url().replace('?placed=1', '');
    await storefront.goto(orderUrl);
    await expect(storefront.getByTestId('order-slot')).toContainText(expectedWhen);

    // --- Admin: the booking is visible on the slot --------------------------------------------
    await admin.reload();
    await expect(admin.getByTestId('slot-row').filter({ hasText: windowText })).toContainText(
      `Band: 1 / ${capacity}`,
    );

    // The customer cancels: the capacity is released.
    await storefront.getByTestId('cancel-order').click();
    const cancel = storefront.getByRole('dialog', { name: 'Buyurtmani bekor qilasizmi?' });
    await cancel.getByRole('button', { name: 'Xato buyurtma berdim' }).click();
    await cancel.getByRole('button', { name: 'Bekor qilish', exact: true }).click();
    await expect(storefront.getByTestId('cancelled-notice')).toBeVisible();

    await admin.reload();
    const reloadedRow = admin.getByTestId('slot-row').filter({ hasText: windowText });
    await expect(reloadedRow).toContainText(`Band: 0 / ${capacity}`);

    // Clean up: an order referenced the slot, so it cannot be deleted; switch it off instead.
    const toggle = reloadedRow.locator('button[aria-pressed]');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    expect(await adminCsp()).toEqual([]);
    expect(await storefrontCsp()).toEqual([]);
    expect(consoleCsp).toEqual([]);
  } finally {
    await adminContext.close();
  }
});
