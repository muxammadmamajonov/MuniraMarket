import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke E2E for the storefront. Not part of `pnpm test`; CI runs it in the separate `e2e` job.
 *
 * Expects:
 * - the web app on `E2E_BASE_URL` (default http://localhost:3000). With `E2E_START_SERVER=1` this
 *   config starts `pnpm start` itself (run `pnpm build` first);
 * - a Core API seeded with the dev catalog (`pnpm api:seed`) reachable from the web server via
 *   `API_INTERNAL_URL`, configured with the same throw-away bot token as `E2E_TELEGRAM_BOT_TOKEN`
 *   so the test's signed Telegram initData is accepted.
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
