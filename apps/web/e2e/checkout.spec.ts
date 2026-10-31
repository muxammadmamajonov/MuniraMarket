import { expect, test, type Page } from '@playwright/test';
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
 * Checkout flow: product -> cart (MainButton "Rasmiylashtirish") -> checkout (district, address,
 * phone, payment; MainButton "Buyurtma berish") -> order page with the number and status NEW ->
 * order history -> cancel.
 *
 * Seed data (`services/api/app/dev/seed.py`): zone `demo-markaziy` serves `yunusobod` with a
 * 50 000 minimum, a 15 000 fee and free delivery from 300 000; `demo-olma` costs 15 000 per kg
 * with 120 in stock. Four kilos (60 000) clear the minimum and stay below the free threshold.
 *
 * Each test signs in as its own fake Telegram user so that specs running in parallel never share
 * a cart. Phone and address are obviously fake demo data.
 */

const ORDER_URL = /\/uz\/orders\/[0-9a-f-]{36}\?placed=1$/;

function user(id: number, username: string): FakeTelegramUser {
  return { id, first_name: 'Checkout', last_name: 'Tester', username, language_code: 'uz' };
}

async function signIn(page: Page, who: FakeTelegramUser): Promise<() => Promise<string[]>> {
  await installTelegramStub(page, buildSignedInitData({ botToken: requireBotToken(), user: who }));
  return trackCspViolations(page);
}

async function productPrice(page: Page, slug: string): Promise<number> {
  const response = await page.request.get(`/api/v1/products/${slug}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { price_uzs: number }).price_uzs;
}

/** Adds `quantity` of a demo product to the cart through the product page's stepper. */
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

test('check out: cart -> delivery details -> order with status NEW -> history -> cancel', async ({
  page,
}) => {
  const cspViolations = await signIn(page, user(900_000_002, 'e2e_checkout'));
  const consoleCsp: string[] = [];
  page.on('console', (message) => {
    if (/content security policy/i.test(message.text())) consoleCsp.push(message.text());
  });

  const unitPrice = await productPrice(page, 'demo-olma');
  const subtotal = 4 * unitPrice;
  expect(
    subtotal,
    'seed prices changed: 4 kg must clear the 50 000 minimum',
  ).toBeGreaterThanOrEqual(50_000);

  await emptyCart(page);
  await addToCart(page, 'demo-olma', 4);

  // Cart: server total, the checkout link, and the native MainButton offering the same step.
  await page.goto('/uz/cart');
  await expect(page.getByTestId('cart-total')).toHaveText(uzs(subtotal));
  await expect(page.getByTestId('checkout-link')).toHaveAttribute('href', '/uz/checkout');
  await expect
    .poll(() => mainButton(page))
    .toMatchObject({ visible: true, text: `Rasmiylashtirish — ${uzs(subtotal)}` });
  await page.getByTestId('checkout-link').click();
  await expect(page).toHaveURL(/\/uz\/checkout$/);

  // Checkout: nothing is preselected; the name comes from the session, the phone starts at +998.
  const district = page.getByLabel('Tuman');
  await expect(district).toBeVisible({ timeout: 15_000 });
  await expect(district).toHaveValue('');
  await expect(page.getByLabel('Ism')).toHaveValue('Checkout Tester');
  await expect(page.getByLabel('Telefon raqami')).toHaveValue('+998 ');
  // The submit control is the MainButton: visible but disabled while the form is incomplete.
  await expect.poll(() => mainButton(page)).toMatchObject({ visible: true, disabled: true });
  expect(await pressMainButton(page)).toBe(false);

  // Delivery price comes from the server quote for the district.
  const zones = (await (await page.request.get('/api/v1/delivery/zones')).json()) as {
    items: Array<{
      districts: Array<{ code: string }>;
      delivery_fee_uzs: number;
      free_delivery_threshold_uzs: number | null;
    }>;
  };
  const zone = zones.items.find((item) => item.districts.some((d) => d.code === 'yunusobod'));
  expect(zone, 'the seed zone for yunusobod').toBeDefined();
  const fee =
    zone?.free_delivery_threshold_uzs != null && subtotal >= zone.free_delivery_threshold_uzs
      ? 0
      : (zone?.delivery_fee_uzs ?? 0);

  await district.selectOption('yunusobod');
  await expect(page.getByTestId('checkout-subtotal')).toHaveText(uzs(subtotal));
  await expect(page.getByTestId('checkout-delivery')).toHaveText(fee === 0 ? 'Bepul' : uzs(fee));
  await expect(page.getByTestId('checkout-total')).toHaveText(uzs(subtotal + fee));

  await page.getByLabel('Ko‘cha').fill('Demo ko‘cha');
  await page.getByLabel('Uy', { exact: true }).fill('12');
  await page.getByLabel('Xonadon').fill('34');
  await page.getByLabel('Telefon raqami').fill('+998 00 123-45-67');
  await page.getByRole('radio', { name: 'Yetkazilganda naqd pul' }).check();
  await page.getByLabel('Kuryer uchun izoh').fill('Demo buyurtma (E2E)');

  await expect
    .poll(() => mainButton(page))
    .toMatchObject({
      visible: true,
      disabled: false,
      text: `Buyurtma berish — ${uzs(subtotal + fee)}`,
    });

  // Place it. Two quick taps must still create exactly one order (checked below through history).
  expect(await pressMainButton(page)).toBe(true);
  await pressMainButton(page);
  await expect(page).toHaveURL(ORDER_URL, { timeout: 20_000 });

  // The order page: success banner, number, status NEW, totals, address.
  await expect(page.getByTestId('placed-banner')).toBeVisible();
  const numberText = (await page.getByTestId('order-number').innerText()).trim();
  const number = numberText.replace(/^Buyurtma № /, '');
  expect(number).not.toBe('');
  await expect(page.locator('[data-status="NEW"]').first()).toHaveText('Yangi');
  await expect(page.getByTestId('order-total')).toHaveText(uzs(subtotal + fee));
  await expect(page.getByRole('region', { name: 'Yetkazib berish manzili' })).toContainText(
    'Yunusobod',
  );
  await expect(page.getByTestId('order-line')).toHaveCount(1);
  const orderUrl = page.url();

  // History lists it exactly once, with its status, and links back to the detail page.
  await page.goto('/uz/orders');
  const card = page.getByTestId('order-card').filter({ hasText: number });
  await expect(card).toHaveCount(1);
  await expect(card.locator('[data-status="NEW"]')).toHaveText('Yangi');
  await expect(card.getByTestId('order-total')).toHaveText(uzs(subtotal + fee));
  await card.click();
  await expect(page).toHaveURL(orderUrl.replace('?placed=1', ''));
  await expect(page.getByTestId('placed-banner')).toHaveCount(0);

  // The cart was emptied by the order.
  await page.goto('/uz/checkout');
  await expect(page.getByText(/Savatingiz bo‘sh/)).toBeVisible({ timeout: 15_000 });

  // Cancel it (also keeps the demo database tidy): quick-pick reason, required text.
  await page.goto(orderUrl.replace('?placed=1', ''));
  await page.getByTestId('cancel-order').click();
  const dialog = page.getByRole('dialog', { name: 'Buyurtmani bekor qilasizmi?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Xato buyurtma berdim' }).click();
  await expect(dialog.getByLabel('Bekor qilish sababi')).toHaveValue('Xato buyurtma berdim');
  await dialog.getByRole('button', { name: 'Bekor qilish', exact: true }).click();
  await expect(page.getByTestId('cancelled-notice')).toBeVisible();
  await expect(page.locator('[data-status="CANCELLED"]').first()).toHaveText('Bekor qilindi');
  await expect(page.getByTestId('cancel-reason')).toHaveText('Xato buyurtma berdim');
  await expect(dialog).toHaveCount(0);

  expect(await cspViolations()).toEqual([]);
  expect(consoleCsp).toEqual([]);
});

test('the proxy forwards Idempotency-Key, reports replays, and serves no back-office routes', async ({
  page,
  baseURL,
}) => {
  await signIn(page, user(900_000_003, 'e2e_idempotency'));
  await emptyCart(page);

  const session = await page.request.get('/api/v1/auth/session');
  expect(session.ok()).toBe(true);
  const csrf = ((await session.json()) as { csrf_token: string }).csrf_token;
  const write = {
    'X-CSRF-Token': csrf,
    Origin: baseURL ?? 'http://localhost:3000',
    'content-type': 'application/json',
  };

  const product = (await (await page.request.get('/api/v1/products/demo-olma')).json()) as {
    id: string;
  };
  const added = await page.request.post('/api/v1/cart/items', {
    headers: write,
    data: { product_id: product.id, quantity: 4 },
  });
  expect(added.status()).toBe(200);

  const quote = await page.request.post('/api/v1/checkout/quote', {
    headers: write,
    data: { district: 'yunusobod' },
  });
  expect(quote.status()).toBe(200);
  const total = ((await quote.json()) as { total_uzs: number }).total_uzs;

  const body = {
    address: { district: 'yunusobod', street: 'Demo ko‘cha', house: '1' },
    recipient_name: 'Idempotency Tester',
    recipient_phone: '+998 00 123 45 67',
    payment_method: 'cash_on_delivery',
    expected_total_uzs: total,
  };
  const key = `e2e-${crypto.randomUUID()}`;
  const place = (data: object, idempotencyKey = key) =>
    page.request.post('/api/v1/orders', {
      headers: { ...write, 'Idempotency-Key': idempotencyKey },
      data,
    });

  const first = await place(body);
  expect(first.status()).toBe(201);
  expect(first.headers()['idempotent-replayed']).toBeUndefined();
  const created = (await first.json()) as { id: string; number: string };

  // Same key, same body (the phone only differs in spacing): the existing order comes back.
  const replay = await place({ ...body, recipient_phone: '+998001234567' });
  expect(replay.status()).toBe(200);
  expect(replay.headers()['idempotent-replayed']).toBe('true');
  expect(((await replay.json()) as { id: string }).id).toBe(created.id);

  // Same key, different body: refused, nothing is created.
  const conflict = await place({ ...body, recipient_name: 'Somebody Else' });
  expect(conflict.status()).toBe(409);
  expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe(
    'idempotency_key_conflict',
  );

  // Cleanup, through the cancel route.
  const cancelled = await page.request.post(`/api/v1/orders/${created.id}/cancel`, {
    headers: write,
    data: { reason: 'E2E cleanup' },
  });
  expect(cancelled.status()).toBe(200);

  // The storefront never proxies the back office or the service-to-service routes.
  for (const path of [
    '/api/v1/admin/orders',
    '/api/v1/admin/orders/x/status',
    '/api/v1/internal/x',
  ]) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('not_found');
  }
});
