import { defineConfig } from '@neon/config/v1';

/**
 * Neon configuration for MuniraMarket (project restless-shadow-93324151, branch `production`,
 * aws-eu-central-1).
 *
 * SAFETY: this file declares only what this repository owns. The live branch also runs the
 * `catalog` and `hello` Functions, Realtime and the `assets`/`uploads` buckets, whose sources are
 * not in this tree; `neon config plan` against `production` shows `+ function coreapi` as the only
 * change (Functions and buckets that are not declared are left alone; Auth and the Data API are
 * declared below so an apply never disables them). Always run the plan first and stop if it
 * shows anything else (infra/neon/README.md).
 *
 * Secrets are declared by NAME only; values come from the deploy shell / `--env` file, never from
 * this file. The Core API connects only with `MM_APP_DATABASE_URL` (pooled endpoint, role
 * `mm_app`, its own password). `DATABASE_URL`/`DATABASE_URL_UNPOOLED` may be injected by Neon
 * (owner role); they are never set by hand here and the Core API never reads them.
 */

const optional = (name: string): Record<string, string> => {
  const value = process.env[name]?.trim();
  return value ? { [name]: value } : {};
};

export default defineConfig({
  // Both are enabled on the live branch; declaring them keeps a config apply from disabling them.
  auth: true,
  dataApi: true,
  functions: {
    coreapi: {
      name: 'MuniraMarket Core API',
      // Prebuilt bundle: run `pnpm --filter @muniramarket/core-api-function build` first
      // (scripts/build.mjs aliases the shared Telegram modules' `sdk` import).
      source: './services/core-api-function/dist',
      bundler: 'none',
      env: {
        // --- secrets (values from the deploy environment only) ---
        // Runtime database: pooled Neon endpoint, user mm_app, mm_app's own password, sslmode=require.
        MM_APP_DATABASE_URL: process.env.MM_APP_DATABASE_URL!,
        CORE_API_FUNCTION_SECRET: process.env.CORE_API_FUNCTION_SECRET!,
        SERVICE_AUTH_KEYS: process.env.SERVICE_AUTH_KEYS!,
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN!,
        TELEGRAM_OIDC_CLIENT_SECRET: process.env.TELEGRAM_OIDC_CLIENT_SECRET!,
        // --- plain configuration ---
        APP_ENV: process.env.APP_ENV!,
        TELEGRAM_BOT_ID: process.env.TELEGRAM_BOT_ID!,
        TELEGRAM_ENVIRONMENT: process.env.TELEGRAM_ENVIRONMENT!,
        TELEGRAM_OIDC_ENABLED: process.env.TELEGRAM_OIDC_ENABLED!,
        TELEGRAM_OIDC_CLIENT_ID: process.env.TELEGRAM_OIDC_CLIENT_ID!,
        WEB_PUBLIC_ORIGIN: process.env.WEB_PUBLIC_ORIGIN!,
        ADMIN_PUBLIC_ORIGIN: process.env.ADMIN_PUBLIC_ORIGIN!,
        CSRF_TRUSTED_ORIGINS: process.env.CSRF_TRUSTED_ORIGINS!,
        ...optional('LOG_LEVEL'),
        ...optional('APP_RELEASE'),
      },
    },
  },
  // Branch policy: per-branch tuning
  branch: (branch) => {
    if (branch.isDefault) {
      // Default branch: no overrides, uses project defaults
      return {};
    }
    if (!branch.exists) {
      // New non-default branches: auto-expire
      return { ttl: '7d' };
    }
    // Existing branch: no changes
    return {};
  },
});
