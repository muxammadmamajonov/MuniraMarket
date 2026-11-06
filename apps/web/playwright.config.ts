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
 *   so the test's signed Telegram initData (storefront Mini App) is accepted, and with
 *   `CSRF_TRUSTED_ORIGINS` listing both origins (`http://localhost:3000,http://localhost:3001`);
 * - for the admin specs, the fake Telegram OIDC provider running on `E2E_OIDC_ISSUER` (default
 *   http://127.0.0.1:8899): `node e2e/fake-telegram-oidc.ts` with `E2E_OIDC_CLIENT_ID`,
 *   `E2E_OIDC_CLIENT_SECRET` (any throw-away value) and `E2E_ADMIN_TELEGRAM_ID`, and the Core API
 *   started with `TELEGRAM_OIDC_ENABLED=true`, `TELEGRAM_OIDC_CLIENT_ID` /
 *   `TELEGRAM_OIDC_CLIENT_SECRET` set to the same values, `TELEGRAM_OIDC_ISSUER` set to that
 *   issuer (development/test only), `WEB_PUBLIC_ORIGIN=http://localhost:3000`,
 *   `ADMIN_PUBLIC_ORIGIN=http://localhost:3001` and `SESSION_COOKIE_SECURE=false`. Without a
 *   gateway, each app's API proxy sets `X-MM-Entrance` itself (storefront / admin);
 * - an admin user with the fake Telegram id in `E2E_ADMIN_TELEGRAM_ID`, created beforehand
 *   (development/test databases only):
 *   `cd services/api && uv run python -m app.dev.set_role "$E2E_ADMIN_TELEGRAM_ID" admin --create`.
 *
 * The admin specs sign in through the real "Sign in with Telegram" OIDC redirect flow: the
 * browser clicks the app's button and goes app -> fake provider -> the API's callback on the admin
 * origin -> app, while the API exchanges the code (PKCE, client secret) and verifies the RS256
 * `id_token` against the fake's JWKS server to server (see `e2e/support.ts`). Nothing in the app
 * is stubbed.
 *
 * Every spec signs in once or twice and the Core API allows 10 logins per minute per IP, in fixed
 * one-minute windows (`AUTH_LOGIN` in `services/api/app/security/rate_limit.py`). The storefront
 * specs use 7 Mini App logins; each admin sign-in costs 2 (`oidc/start` and the callback), so the
 * admin specs use 5. Together that is more than one window allows, so CI runs the two groups
 * separately with `E2E_SKIP_ADMIN=1` first, then `admin-` after the next minute starts. Locally,
 * likewise wait about a minute between runs against the same API.
 *
 * Browsers are installed explicitly: `pnpm --filter @muniramarket/web exec playwright install chromium`
 */
const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  // `E2E_SKIP_ADMIN=1` runs only the storefront specs (see the rate-limit note above).
  ...(process.env['E2E_SKIP_ADMIN'] === '1' ? { testIgnore: /admin-[^/]*\.spec\.ts$/ } : {}),
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
