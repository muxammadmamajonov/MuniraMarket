import { defineConfig, devices } from '@playwright/test';

/**
 * E2E for the storefront and the admin app. Not part of `pnpm test`; CI runs it in the separate
 * `e2e` job.
 *
 * Expects:
 * - the web app on `E2E_BASE_URL` (default http://localhost:3000). With `E2E_START_SERVER=1` this
 *   config starts `pnpm start` itself (run `pnpm build` first);
 * - the admin app on `E2E_ADMIN_URL` (default http://localhost:3001), started separately
 *   (`pnpm --filter @muniramarket/admin build && pnpm --filter @muniramarket/admin start`); only
 *   `admin-*.spec.ts` use it;
 * - a Core API seeded with the dev catalog (`pnpm api:seed`) reachable from both servers via
 *   `API_INTERNAL_URL`, configured with the same throw-away bot token as `E2E_TELEGRAM_BOT_TOKEN`
 *   so the test's signed Telegram initData (storefront) and Login Widget fields (admin) are
 *   accepted. For the admin specs the API also needs `TELEGRAM_LOGIN_WIDGET_ENABLED=true`,
 *   `TELEGRAM_BOT_USERNAME=<any 5-32 char name>` and `CSRF_TRUSTED_ORIGINS` listing both origins
 *   (`http://localhost:3000,http://localhost:3001`);
 * - an admin user with the fake Telegram id in `E2E_ADMIN_TELEGRAM_ID`, created beforehand
 *   (development/test databases only):
 *   `cd services/api && uv run python -m app.dev.set_role "$E2E_ADMIN_TELEGRAM_ID" admin --create`.
 *
 * The admin specs sign in through the real Login Widget redirect flow: the widget script is the
 * only thing replaced (see `e2e/support.ts`), so the app's one-time login state, the callback page
 * and the API's HMAC check all run for real.
 *
 * Every spec signs in once or twice and the Core API allows 10 logins per minute per IP
 * (`AUTH_LOGIN` in `services/api/app/security/rate_limit.py`); a full run uses 8 of them, so wait
 * about a minute before starting a second full run against the same API.
 *
 * Browsers are installed explicitly: `pnpm --filter @muniramarket/web exec playwright install chromium`
 */
const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    // Mobile-first: the storefront is designed for phones and Telegram webviews.
    ...devices['Pixel 7'],
  },
  ...(process.env['E2E_START_SERVER'] === '1'
    ? {
        webServer: {
          command: 'pnpm start',
          url: baseURL,
          reuseExistingServer: true,
          timeout: 60_000,
        },
      }
    : {}),
});
