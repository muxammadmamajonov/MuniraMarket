import { expect, test, type Locator, type Page } from '@playwright/test';
import { botSyncUser } from './bot';
import { installTelegramStub, requireBotToken } from './support';
import { buildSignedInitData, type FakeTelegramUser } from './telegram-init-data';

/**
 * The Profile hub as a settings app: each row opens its own page (title in the header slot,
 * Telegram's BackButton for "back"):
 *
 * - Personal details: name and a typed birthday are saved with `PATCH /me` and survive a reload;
 *   the bot's next user sync no longer overwrites a name the customer edited; a typed phone is
 *   saved but shown as not verified;
 * - My addresses: saved addresses (seeded through the same API the editor uses, so this spec
 *   needs no map key), default first; swipe left reveals "O‘chirish"; the delete button is also
 *   reachable by keyboard; tapping a row opens the editor;
 * - Language: a checkmark list; the change applies at once;
 * - My orders: a status segmented control whose state is in the URL, each tab with its own
 *   empty state.
 *
 * One Mini App login (one fresh Telegram id per run).
 */

const RUN = Date.now() % 1_000_000;
const WHO: FakeTelegramUser = {
  id: 920_000_000 + RUN,
  first_name: 'Hub',
  last_name: 'Tester',
  username: `e2e_hub_${RUN}`,
  language_code: 'uz',
};

const HOME = {
  lat: 41.311081,
  lon: 69.240562,
  street: 'Amir Temur ko‘chasi',
  house: '15',
  apartment: '4',
  label: 'Uy',
};
const WORK = {
  lat: 41.2995,
  lon: 69.2401,
  street: 'Bobur ko‘chasi',
  house: '7',
  label: 'Boshqa joy',
};

/** `POST /me/addresses` from the page itself (same cookies, CSRF token from the session). */
async function seedAddress(page: Page, body: Record<string, unknown>): Promise<number> {
  return page.evaluate(async (payload) => {
    const session = (await (await fetch('/api/v1/auth/session')).json()) as { csrf_token: string };
    const response = await fetch('/api/v1/me/addresses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-CSRF-Token': session.csrf_token },
      body: JSON.stringify(payload),
    });
    return response.status;
  }, body);
}

async function swipeLeft(page: Page, row: Locator, distance: number): Promise<void> {
  const box = await row.boundingBox();
  if (box === null) throw new Error('row not visible');
  const y = box.y + box.height / 2;
  const startX = box.x + box.width - 24;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(startX - (distance * step) / 8, y + 1);
  }
  await page.mouse.up();
}

async function headerTitle(page: Page): Promise<Locator> {
  return page.getByRole('banner').getByTestId('header-title').filter({ visible: true });
}

test('profile hub: personal details, addresses, language and order tabs', async ({ page }) => {
  await installTelegramStub(page, buildSignedInitData({ botToken: requireBotToken(), user: WHO }), {
    verifiedPhone: false,
  });

  // --- the hub ------------------------------------------------------------------------------
  await page.goto('/uz/profile');
  await expect(page.getByTestId('profile-name')).toHaveText('Hub Tester');
  const account = page.getByRole('region', { name: 'Hisob' });
  await expect(account.getByRole('link')).toHaveText([
    'Shaxsiy ma’lumotlar',
    'Buyurtmalarim',
    'Manzillarim',
  ]);

  // --- personal details ---------------------------------------------------------------------
  await page.getByTestId('profile-personal-row').click();
  await expect(page).toHaveURL(/\/uz\/profile\/personal$/);
  await expect(await headerTitle(page)).toHaveText('Ma’lumotlar');
  await expect(page.getByTestId('personal-save')).toBeDisabled();
  await page.getByTestId('first-name-input').fill('Munira');
  await page.getByTestId('last-name-input').fill('');
  // Digits only: the mask adds the dots.
  await page.getByTestId('birth-date-input').pressSequentially('09032001');
  await expect(page.getByTestId('birth-date-input')).toHaveValue('09.03.2001');
  await page.getByTestId('personal-save').click();
  await expect(page.getByTestId('personal-notice')).toHaveText('Saqlandi');

  // The bot's next user sync (it sends the Telegram name) must not undo the customer's edit.
  await botSyncUser(WHO);
  await page.reload();
  await expect(page.getByTestId('first-name-input')).toHaveValue('Munira');
  await expect(page.getByTestId('last-name-input')).toHaveValue('');
  await expect(page.getByTestId('birth-date-input')).toHaveValue('09.03.2001');

  // A future birthday is refused before any request.
  await page.getByTestId('birth-date-input').fill('');
  await page.getByTestId('birth-date-input').pressSequentially('01012999');
  await page.getByTestId('personal-save').click();
  await expect(page.getByText('Sana kelajakda bo‘lishi mumkin emas')).toBeVisible();
  await page.reload();

  // A typed phone: saved, masked, and honestly "not verified".
  await page.getByTestId('phone-change').click();
  const phone = page.getByTestId('phone-manual-input');
  await expect(phone).toHaveValue('');
  await phone.pressSequentially('901234567');
  await expect(phone).toHaveValue('90 123 45 67');
  await page.getByTestId('phone-manual-save').click();
  await expect(page.getByTestId('personal-notice')).toHaveText('Raqam saqlandi');
  await expect(page.getByTestId('phone-value')).toContainText('45 67');
  await expect(page.getByTestId('phone-state')).toHaveText('Tasdiqlanmagan');
  expect(await page.content()).not.toContain('901234567');

  // --- addresses ----------------------------------------------------------------------------
  await page.goto('/uz/profile/addresses');
  await expect(await headerTitle(page)).toHaveText('Manzillarim');
  await expect(page.getByText('Saqlangan manzillar yo‘q')).toBeVisible();
  expect(await seedAddress(page, HOME)).toBe(201);
  expect(await seedAddress(page, WORK)).toBe(201);
  await page.reload();
  const rows = page.getByTestId('address-row');
  await expect(rows).toHaveCount(2);
  // The first address became the default and is listed first.
  await expect(rows.first()).toContainText('Uy');
  await expect(rows.first().getByTestId('address-default')).toHaveText('Asosiy');

  // Swipe the second row left: the red action shows; a tap elsewhere closes it.
  const second = rows.nth(1);
  await swipeLeft(page, second, 120);
  await expect(second.getByTestId('swipe-row')).toHaveAttribute('data-open', 'true');
  await expect(second.getByTestId('swipe-delete')).toBeInViewport();
  await page.mouse.click(4, 120);
  await expect(second.getByTestId('swipe-row')).toHaveAttribute('data-open', 'false');

  // Tap opens the editor; rename it to "Ish" and save.
  await second.getByRole('link').click();
  await expect(page).toHaveURL(/\/uz\/profile\/addresses\/[0-9a-f-]+$/);
  await expect(await headerTitle(page)).toHaveText('Manzil');
  await expect(page.getByTestId('address-summary')).toContainText('Bobur ko‘chasi, 7');
  await expect(page.getByTestId('address-label-input')).toHaveValue('Boshqa joy');
  await page.getByTestId('address-label-work').click();
  await page.getByTestId('address-save').click();
  await expect(page).toHaveURL(/\/uz\/profile\/addresses$/);
  await expect(rows.nth(1)).toContainText('Ish');

  // Delete with the keyboard: Tab to the row's delete button (it slides the row open).
  await rows.nth(1).getByRole('link').focus();
  await page.keyboard.press('Tab');
  await expect(rows.nth(1).getByTestId('swipe-row')).toHaveAttribute('data-open', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('addresses-notice')).toHaveText('Manzil o‘chirildi');
  await page.reload();
  await expect(rows).toHaveCount(1);

  // --- language -----------------------------------------------------------------------------
  await page.goto('/uz/profile');
  await page.getByTestId('profile-language-row').click();
  await expect(await headerTitle(page)).toHaveText('Til');
  await page.getByRole('radio', { name: 'Русский' }).click();
  await expect(page).toHaveURL(/\/ru\/profile\/language$/);
  await expect(page.getByRole('radio', { name: 'Русский' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // --- orders: tabs in the URL, each with its own empty state -------------------------------
  await page.goto('/ru/orders');
  const tabs = page.getByRole('navigation', { name: 'Фильтр по статусу' });
  await expect(tabs.getByRole('link')).toHaveText([
    'Все',
    'Активные',
    'В пути',
    'Завершённые',
    'Отменённые',
  ]);
  await expect(tabs.getByRole('link', { name: 'Все' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Заказов пока нет')).toBeVisible();
  await tabs.getByRole('link', { name: 'В пути' }).click();
  await expect(page).toHaveURL(/\/ru\/orders\?status=delivering$/);
  await expect(page.getByText('Нет заказов в пути')).toBeVisible();
  await page.reload();
  await expect(tabs.getByRole('link', { name: 'В пути' })).toHaveAttribute('aria-current', 'page');

  // Restore the language for later specs that open /uz pages as this user (none today).
  await page.goto('/ru/profile/language');
  await page.getByRole('radio', { name: 'O‘zbekcha' }).click();
  await expect(page).toHaveURL(/\/uz\/profile\/language$/);
});
