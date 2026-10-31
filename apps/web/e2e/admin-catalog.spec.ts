import { expect, test } from '@playwright/test';
import {
  adminWriteHeaders,
  newAdminContext,
  signInToAdmin,
  trackConsoleCsp,
  trackCspViolations,
  uzs,
} from './support';

/**
 * Admin login -> product update -> storefront.
 *
 * An admin signs in to the admin app through the Telegram Login Widget redirect (see
 * `signInToAdmin` in `support.ts`), finds a seeded product in Catalog -> Products, changes its
 * price and stock, saves, and the storefront product page then shows the new price. The original
 * values are restored through the UI at the end (and, as a safety net, through the API if the test
 * fails halfway), so the other specs keep seeing the seed data.
 *
 * `demo-sabzi` is used because no other spec buys or asserts it: `checkout.spec.ts` and
 * `checkout-slots.spec.ts` rely on the `demo-olma` price.
 *
 * The admin and the storefront live on different origins of the same host (localhost ports), and
 * cookies are not port-specific, so the admin gets its own browser context.
 */

const SLUG = 'demo-sabzi';
const SKU = 'DEMO-0006';
const PRICE_RAISE = 1_500;
const STOCK_DROP = 13;

interface ProductValues {
  price: number;
  stock: number | null;
}

function integerOf(text: string): number {
  return Number(text.replace(/\D/g, ''));
}

test('admin signs in with the Login Widget, changes a product price, and the storefront shows it', async ({
  page: storefront,
  browser,
}) => {
  // Storefront: a plain website visitor, no Telegram session (and no extra login: the Core API
  // allows 10 logins per minute per IP, which the whole suite shares). telegram.org stays blocked.
  await storefront.route(/^https:\/\/([^/]+\.)?telegram\.org\//, (route) => route.abort());
  const storefrontCsp = await trackCspViolations(storefront);

  const admin = await newAdminContext(browser);
  const page = await admin.newPage();
  const adminCsp = await trackCspViolations(page);
  const consoleCsp = trackConsoleCsp(page);
  trackConsoleCsp(storefront, consoleCsp);

  let productId: string | null = null;
  let original: ProductValues | null = null;

  try {
    await signInToAdmin(page);
    // The signed-in account is shown in the navigation (fake name from the Login Widget fields).
    await expect(page.getByText('E2E', { exact: false }).first()).toBeVisible();

    // Catalog -> Products: search for the seeded product and open it.
    await page.getByTestId('nav-products').click();
    await expect(page).toHaveURL(/\/uz\/catalog\/products$/);
    await page.getByTestId('product-search').fill(SKU);
    const row = page.getByTestId('product-row-link');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Demo sabzi');
    await row.click();
    await expect(page).toHaveURL(/\/uz\/catalog\/products\/[0-9a-f-]{36}$/);
    productId = page.url().split('/').pop() ?? null;

    const priceInput = page.getByTestId('price-input');
    const stockInput = page.getByTestId('stock-input');
    await expect(priceInput).toBeVisible({ timeout: 15_000 });
    await expect(priceInput).not.toHaveValue('');
    const originalStock = (await stockInput.inputValue()).trim();
    original = {
      price: integerOf(await priceInput.inputValue()),
      stock: originalStock === '' ? null : integerOf(originalStock),
    };
    expect(original.price, 'seed price of demo-sabzi').toBeGreaterThan(0);
    const updated: ProductValues = {
      price: original.price + PRICE_RAISE,
      stock: original.stock === null ? null : original.stock - STOCK_DROP,
    };

    const save = async (values: ProductValues): Promise<void> => {
      await priceInput.fill(String(values.price));
      if (values.stock !== null) await stockInput.fill(String(values.stock));
      const patched = page.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' &&
          new URL(response.url()).pathname === `/api/v1/admin/products/${productId}`,
      );
      await page.getByTestId('save-button').click();
      expect((await patched).status()).toBe(200);
      await expect(
        page.getByRole('status').filter({ hasText: 'Mahsulot saqlandi.' }),
      ).toBeVisible();
    };

    // Change the price (and stock) and save.
    await save(updated);
    await expect(priceInput).toHaveValue(String(updated.price));

    // The storefront reads the same product through the Core API: the new price is shown.
    await storefront.goto(`/uz/p/${SLUG}`);
    await expect(storefront.getByRole('main').getByTestId('product-price')).toContainText(
      uzs(updated.price),
    );

    // The change survives a reload of the admin form (it was stored, not just displayed).
    await page.reload();
    await expect(page.getByTestId('price-input')).toHaveValue(String(updated.price));
    if (updated.stock !== null) {
      await expect(page.getByTestId('stock-input')).toHaveValue(String(updated.stock));
    }

    // Restore the seed values through the UI and see the storefront follow.
    await save(original);
    await storefront.goto(`/uz/p/${SLUG}`);
    await expect(storefront.getByRole('main').getByTestId('product-price')).toContainText(
      uzs(original.price),
    );

    expect(await adminCsp()).toEqual([]);
    expect(await storefrontCsp()).toEqual([]);
    expect(consoleCsp).toEqual([]);
  } finally {
    // Safety net: whatever happened above, leave the seed values behind. A no-op after a clean run.
    if (productId !== null && original !== null) {
      await page.goto('/uz');
      const response = await page.request.patch(`/api/v1/admin/products/${productId}`, {
        headers: await adminWriteHeaders(page),
        data: {
          price_uzs: original.price,
          ...(original.stock === null ? {} : { stock_quantity: original.stock }),
        },
      });
      expect(response.ok(), 'restoring the seed values of demo-sabzi').toBe(true);
    }
    await admin.close();
  }
});
