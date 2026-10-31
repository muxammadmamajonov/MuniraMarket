import { expect, test, type Page } from '@playwright/test';
import {
  emptyCart,
  installTelegramStub,
  mainButton,
  pressMainButton,
  requireBotToken,
} from './support';
import { buildSignedInitData } from './telegram-init-data';

/**
 * An order attempt whose answer never arrived, followed by a reload. The pending attempt (key and
 * a hash of the body) lives in `sessionStorage`, so:
 *
 * 1. a request that never reached the server is retried after the reload with the SAME
 *    `Idempotency-Key` when the customer sends the same details, and exactly one order exists;
 * 2. a request that did reach the server (its answer was lost) leaves the cart empty; the
 *    checkout then says "we found your order" and links to it.
 *
 * One sign-in for both (the Core API allows 10 logins per minute per IP). Seed data as in
 * `checkout.spec.ts`: four kilos of `demo-olma` clear the yunusobod minimum.
 */

const ORDERS = '**/api/v1/orders';

async function addToCart(page: Page, slug: string, quantity: number): Promise<void> {
  await page.goto(`/uz/p/${slug}`);
  const add = page.getByRole('button', { name: 'Savatga qo‘shish' });
  await expect(add).toBeEnabled({ timeout: 15_000 });
  for (let value = 1; value < quantity; value += 1) {
    await page.getByRole('button', { name: 'Ko‘paytirish' }).click();
  }
  await add.click();
  await expect(page.getByTestId('added-message')).toBeVisible();
}

/** The same details every time, so the request body is identical across a reload. */
async function fillCheckout(page: Page): Promise<void> {
  await page.goto('/uz/checkout');
  const district = page.getByLabel('Tuman');
  await expect(district).toBeVisible({ timeout: 15_000 });
  await district.selectOption('yunusobod');
  await expect(page.getByTestId('checkout-total')).not.toHaveText('—');
  await page.getByLabel('Ko‘cha').fill('Demo ko‘cha');
  await page.getByLabel('Uy', { exact: true }).fill('12');
  await page.getByLabel('Telefon raqami').fill('+998 00 123-45-67');
  await page.getByRole('radio', { name: 'Yetkazilganda naqd pul' }).check();
  await expect.poll(() => mainButton(page)).toMatchObject({ visible: true, disabled: false });
}

/** Keys of the `POST /orders` requests the page sent. */
function trackOrderKeys(page: Page): string[] {
  const keys: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/orders') {
      keys.push(request.headers()['idempotency-key'] ?? '');
    }
  });
  return keys;
}

/** Cancels the order on the current order page (keeps the demo database tidy). */
async function cancelHere(page: Page): Promise<void> {
  await page.getByTestId('cancel-order').click();
  const dialog = page.getByRole('dialog', { name: 'Buyurtmani bekor qilasizmi?' });
  await dialog.getByRole('button', { name: 'Xato buyurtma berdim' }).click();
  await dialog.getByRole('button', { name: 'Bekor qilish', exact: true }).click();
  await expect(page.getByTestId('cancelled-notice')).toBeVisible();
}

test('an unanswered order survives a reload: same key for the same body, or "we found your order"', async ({
  page,
}) => {
  await installTelegramStub(
    page,
    buildSignedInitData({
      botToken: requireBotToken(),
      user: {
        id: 900_000_010,
        first_name: 'Reload',
        last_name: 'Tester',
        username: 'e2e_reload',
        language_code: 'uz',
      },
    }),
  );
  const keys = trackOrderKeys(page);

  // 1. The request never reaches the server; the customer reloads and sends the same details.
  await emptyCart(page);
  await addToCart(page, 'demo-olma', 4);
  await fillCheckout(page);
  await page.route(ORDERS, (route) => route.abort('timedout'));
  expect(await pressMainButton(page)).toBe(true);
  await expect(page.getByTestId('submit-failure')).toHaveAttribute('data-failure', 'network');
  await page.unroute(ORDERS);

  await page.reload();
  await fillCheckout(page);
  expect(await pressMainButton(page)).toBe(true);
  await expect(page).toHaveURL(/\/uz\/orders\/[0-9a-f-]{36}\?placed=1$/, { timeout: 20_000 });
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  const firstNumber = (await page.getByTestId('order-number').innerText()).trim();
  await cancelHere(page);

  // 2. The request reaches the server and creates the order, but its answer is lost.
  await addToCart(page, 'demo-olma', 4);
  await fillCheckout(page);
  await page.route(ORDERS, async (route) => {
    await route.fetch();
    await route.abort('timedout');
  });
  expect(await pressMainButton(page)).toBe(true);
  await expect(page.getByTestId('submit-failure')).toHaveAttribute('data-failure', 'network');
  await page.unroute(ORDERS);

  // After the reload the cart is empty (the order took its items): the checkout finds the order.
  await page.reload();
  const recovered = page.getByTestId('recovered-order');
  await expect(recovered).toBeVisible({ timeout: 15_000 });
  await expect(recovered).toContainText('Buyurtmangizni topdik');
  await recovered.getByRole('link', { name: 'Buyurtmani ochish' }).click();
  await expect(page).toHaveURL(/\/uz\/orders\/[0-9a-f-]{36}\?placed=found$/);
  await expect(page.getByTestId('placed-banner')).toHaveAttribute('data-found', 'true');
  const secondNumber = (await page.getByTestId('order-number').innerText()).trim();
  expect(secondNumber).not.toBe(firstNumber);
  await cancelHere(page);

  // Exactly two orders were created: one per scenario, none twice.
  const history = (await (await page.request.get('/api/v1/orders?page_size=5')).json()) as {
    items: Array<{ number: string }>;
  };
  const numbers = history.items.map((item) => `Buyurtma № ${item.number}`);
  expect(numbers.filter((n) => n === firstNumber)).toHaveLength(1);
  expect(numbers.filter((n) => n === secondNumber)).toHaveLength(1);
});
