import { bindings, defineConfig, exports, triggers } from 'cf/config';
import { deploymentTarget } from '../../infra/cloudflare/environments.mts';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

/**
 * Core API gateway Worker (Workers Free plan: no Containers, Durable Objects or image registry).
 * It forwards to the Core API Neon Function `coreapi` (services/core-api-function). One
 * configuration per mode: `--mode staging` or `--mode production`; anything else is local
 * development. No secret, account id, Function URL or hostname lives in this file:
 *
 * - secrets are declared with `bindings.secret()` and set per Worker (infra/cloudflare/README.md);
 * - the public hostname comes from `MM_API_HOSTNAME` at deploy time (unset: no public route).
 *
 * Core API configuration (APP_ENV, Telegram, OIDC, CSRF origins, ...) now lives on the Neon
 * Function (neon.ts), not here.
 */
export default defineConfig(({ mode }) => {
  const target = deploymentTarget(mode);
  const hostname = process.env['MM_API_HOSTNAME']?.trim();

  return {
    worker: {
      name: `muniramarket-api-gateway${target.suffix}`,
      compatibilityDate: '2026-10-30',
      compatibilityFlags: ['nodejs_compat'],
      entrypoint,
      // Only the explicit hostname (Telegram Serverless + health checks) is public; the
      // storefront and admin reach the API through service bindings.
      workersDev: false,
      previewUrls: false,
      ...(target.deployed && hostname ? { domains: [hostname] } : {}),
      // Signs the outbox drain every minute and the security-state cleanup every 15 minutes; the
      // work itself runs in the Function (src/scheduler.ts). Deployed modes only.
      ...(target.deployed ? { triggers: [triggers.scheduled({ schedule: '* * * * *' })] } : {}),
      observability: {
        enabled: true,
        logs: { enabled: true, headSamplingRate: 1, invocationLogs: true },
        traces: { enabled: true, headSamplingRate: target.production ? 0.1 : 1 },
        // Query strings never reach Workers Logs or traces.
        redactQueryString: true,
      },
      exports: {
        StorefrontApi: exports.worker(),
        AdminApi: exports.worker(),
      },
      env: {
        // --- secrets (never in this file) ---
        // `invocation_url` of the `coreapi` Function (`neon functions get coreapi`), origin only.
        CORE_API_FUNCTION_ORIGIN: bindings.secret(),
        // Sent as `X-MM-Gateway-Secret` on every Function request; same value in the Function's
        // CORE_API_FUNCTION_SECRET.
        CORE_API_FUNCTION_SECRET: bindings.secret(),
        // The Cron Trigger's signing secret; the Function's SERVICE_AUTH_KEYS holds
        // `scheduler:<same secret>`.
        SCHEDULER_SERVICE_SECRET: bindings.secret(),

        // --- plain configuration ---
        SCHEDULER_SERVICE_KEY_ID: bindings.text('scheduler'),
      },
    },
  };
});
