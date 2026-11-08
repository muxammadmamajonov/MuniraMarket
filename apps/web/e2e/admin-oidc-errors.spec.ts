import { expect, test, type Request } from '@playwright/test';
import {
  adminBaseUrl,
  newAdminContext,
  oidcIssuer,
  requireAdminTelegramId,
  trackConsoleCsp,
  trackCspViolations,
} from './support';

/**
 * Admin "Sign in with Telegram" when something goes wrong, then right.
 *
 * 1. The sign-in failure page explains each callback status (denied, expired/invalid state,
 *    service unavailable, blocked) and shows the support code from `?ref=`; only "blocked" offers
 *    no new attempt. Plain navigations: no login is spent.
 * 2. An expired/unknown `state` sent to the real callback lands on that page (`status=failed`),
 *    never on a JSON error. One login is spent (the callback is rate limited).
 * 3. The start fails once (the browser's `POST .../oidc/start` is answered with a 503 and an
 *    `X-Request-ID`, exactly what the admin proxy returns after its own retry gave up): the page
 *    says the service is unavailable, shows the support code and offers "try again"; the second
 *    attempt goes through the real OIDC redirect flow (fake provider, real Core API callback) and
 *    ends signed in. Two logins (start + callback).
 *
 * Three logins in all: the admin specs together stay within the Core API's 10 per minute (see the
 * note in `playwright.config.ts`).
 */

const REQUEST_ID = 'e2e0fa11c0de4b1d8a0a5e5e5e5e5e5e';
const SUPPORT_CODE = 'e2e0fa11';

test('sign-in errors explain themselves, show a support code and recover on retry', async ({
  browser,
}) => {
  requireAdminTelegramId();
  const issuer = oidcIssuer();
  const admin = await newAdminContext(browser);
  const page = await admin.newPage();
  const csp = await trackCspViolations(page);
  const consoleCsp = trackConsoleCsp(page);
  // Only the fake provider may be visited; real Telegram stays blocked.
  await page.route(/^https:\/\/([^/]+\.)?telegram\.org\//, (route) => route.abort());

  // --- 1. The failure page, status by status -----------------------------------------------
  const statuses: [string, RegExp][] = [
    ['cancelled', /Telegram’da kirish rad etildi/],
    ['failed', /Kirish havolasi eskirgan yoki tasdiqlanmadi/],
    ['unavailable', /Xizmat vaqtincha ishlamayapti/],
  ];
  for (const [status, message] of statuses) {
    await page.goto(`/uz/auth/telegram?status=${status}&ref=0a1b2c3d`);
    const card = page.getByTestId('login-callback');
    await expect(card.getByRole('heading', { name: 'Kirish amalga oshmadi' })).toBeVisible();
    await expect(card.getByRole('alert')).toHaveText(message);
    await expect(card.getByTestId('support-code')).toHaveText('Yordam kodi: 0a1b2c3d');
    await expect(card.getByRole('button', { name: 'Qayta urinish' })).toBeVisible();
  }
  await page.goto('/uz/auth/telegram?status=blocked');
  await expect(page.getByTestId('login-callback').getByRole('alert')).toHaveText(
    /Hisobingiz bloklangan/,
  );
  await expect(page.getByTestId('telegram-login-button')).toHaveCount(0);
  await expect(page.getByTestId('support-code')).toHaveCount(0);

  // --- 2. An unknown/expired state at the real callback ------------------------------------
  await page.goto('/api/v1/auth/telegram/oidc/callback?code=e2e-code&state=expired');
  await expect(page).toHaveURL(/\/uz\/auth\/telegram\?status=failed/);
  await expect(page.getByTestId('login-callback').getByRole('alert')).toHaveText(
    /Kirish havolasi eskirgan/,
  );

  // --- 3. Start fails once, then succeeds ----------------------------------------------------
  let failedStarts = 0;
  await page.route('**/api/v1/auth/telegram/oidc/start', async (route) => {
    if (failedStarts > 0) {
      await route.fallback();
      return;
    }
    failedStarts += 1;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      headers: { 'x-request-id': REQUEST_ID, 'cache-control': 'no-store' },
      body: JSON.stringify({
        error: { code: 'service_unavailable', message: 'Service temporarily unavailable' },
      }),
    });
  });

  await page.goto('/uz');
  const signIn = page.getByTestId('sign-in-card');
  await expect(signIn).toBeVisible({ timeout: 20_000 });
  await signIn.getByRole('button', { name: 'Telegram orqali kirish' }).click();

  const error = page.getByTestId('login-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText('Xizmat vaqtincha ishlamayapti');
  await expect(error.getByTestId('support-code')).toHaveText(`Yordam kodi: ${SUPPORT_CODE}`);
  expect(failedStarts).toBe(1);
  // Still on our page: the failed start never navigated anywhere.
  await expect(page).toHaveURL(/\/uz\/?$/);

  const visited: string[] = [];
  const onRequest = (request: Request) => {
    if (!request.isNavigationRequest()) return;
    const url = new URL(request.url());
    visited.push(`${url.origin}${url.pathname}`);
  };
  page.on('request', onRequest);

  const retry = signIn.getByRole('button', { name: 'Qayta urinish' });
  await expect(retry).toHaveAttribute('aria-busy', 'false');
  await retry.click();

  await expect(page.getByTestId('nav-products')).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/uz\/?$/);
  page.off('request', onRequest);
  expect(visited).toContain(`${issuer}/auth`);
  expect(visited).toContain(`${adminBaseUrl()}/api/v1/auth/telegram/oidc/callback`);
  await expect(page.getByTestId('login-error')).toHaveCount(0);

  expect(await csp()).toEqual([]);
  expect(consoleCsp).toEqual([]);
  await admin.close();
});
