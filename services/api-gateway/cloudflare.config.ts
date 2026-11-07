import { bindings, defineConfig, defineContainer, exports, triggers } from 'cf/config';
import { deploymentTarget } from '../../infra/cloudflare/environments.mts';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

/**
 * Core API gateway Worker + the FastAPI container (Cloudflare Containers, Durable Object
 * scheduling). One configuration per mode: `--mode staging` or `--mode production`; anything else
 * is local development. No secret, account id, hostname or image digest lives in this file:
 *
 * - secrets are declared with `bindings.secret()` and set per Worker (infra/cloudflare/README.md);
 * - the public hostname comes from `MM_API_HOSTNAME` at deploy time (unset: no public route);
 * - the image is `CORE_API_IMAGE` (an immutable `registry/...@sha256:` reference from the release
 *   workflow) when set, otherwise it is built from services/api/Dockerfile.
 */
export default defineConfig(({ mode }) => {
  const target = deploymentTarget(mode);
  const image = process.env['CORE_API_IMAGE']?.trim();

  const coreApi = defineContainer({
    name: `muniramarket-core-api${target.suffix}`,
    schedulingPolicy: 'durable-object',
    observability: { enabled: true, logs: { enabled: true } },
    images: {
      api: image ? { reference: image } : { dockerfile: '../api/Dockerfile' },
    },
  });

  const hostname = process.env['MM_API_HOSTNAME']?.trim();
  // Public browser origins whose /api/v1/auth/telegram/oidc/callback is registered with BotFather.
  const origin = (name: string) => {
    const host = process.env[name]?.trim();
    return host ? `https://${host}` : '';
  };

  return {
    containers: [coreApi],
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
      // Drains the notification outbox every minute and cleans expired security state every 15
      // minutes (src/scheduler.ts). Deployed modes only: local `cf dev` stays quiet.
      ...(target.deployed ? { triggers: [triggers.scheduled({ schedule: '* * * * *' })] } : {}),
      observability: {
        enabled: true,
        logs: { enabled: true, headSamplingRate: 1, invocationLogs: true },
        traces: { enabled: true, headSamplingRate: target.production ? 0.1 : 1 },
        // Query strings never reach Workers Logs or traces.
        redactQueryString: true,
      },
      exports: {
        CoreApiContainer: exports.durableObject({ storage: 'sqlite', container: coreApi }),
        StorefrontApi: exports.worker(),
        AdminApi: exports.worker(),
      },
      env: {
        // --- gateway ---
        CONTAINER_INSTANCES: bindings.text(target.production ? '3' : '2'),
        CONTAINER_SLEEP_AFTER_MINUTES: bindings.text(target.production ? '120' : '30'),

        // --- secrets passed to the container (never in this file) ---
        DATABASE_URL: bindings.secret(),
        // Also read by the Cron Trigger: its signing key is the SCHEDULER_SERVICE_KEY_ID entry.
        SERVICE_AUTH_KEYS: bindings.secret(),
        // Also used by the Cron Trigger to send order notifications through the Bot API.
        TELEGRAM_BOT_TOKEN: bindings.secret(),
        // Telegram OIDC (one bot) client secret: server-side code exchange only.
        TELEGRAM_OIDC_CLIENT_SECRET: bindings.secret(),

        // --- gateway Cron Trigger (not passed to the container) ---
        SCHEDULER_SERVICE_KEY_ID: bindings.text('scheduler'),

        // --- plain container configuration ---
        APP_ENV: bindings.text(target.appEnv),
        APP_RELEASE: bindings.text(process.env['APP_RELEASE']?.trim() ?? ''),
        LOG_LEVEL: bindings.text('INFO'),
        TELEGRAM_ENVIRONMENT: bindings.text('production'),
        TELEGRAM_OIDC_ENABLED: bindings.text('true'),
        // Public OIDC client id of the bot (not a secret).
        TELEGRAM_OIDC_CLIENT_ID: bindings.text('9038491407'),
        // Set per environment from deploy-time variables (not secret, not committed):
        // MM_TELEGRAM_BOT_ID, MM_WEB_HOSTNAME, MM_ADMIN_HOSTNAME, MM_CSRF_TRUSTED_ORIGINS.
        TELEGRAM_BOT_ID: bindings.text(process.env['MM_TELEGRAM_BOT_ID']?.trim() ?? ''),
        WEB_PUBLIC_ORIGIN: bindings.text(origin('MM_WEB_HOSTNAME')),
        ADMIN_PUBLIC_ORIGIN: bindings.text(origin('MM_ADMIN_HOSTNAME')),
        CSRF_TRUSTED_ORIGINS: bindings.text(process.env['MM_CSRF_TRUSTED_ORIGINS']?.trim() ?? ''),
        // The container's only ingress is its Durable Object, and this gateway rewrites
        // X-Forwarded-For on every request, so trusting the private ranges the platform's
        // proxy connects from is safe (ADR 0011). Narrow it once staging shows the peer.
        FORWARDED_ALLOW_IPS: bindings.text(
          '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,fc00::/7,fe80::/10',
        ),
        DB_POOL_SIZE: bindings.text('5'),
        DB_MAX_OVERFLOW: bindings.text('5'),
      },
    },
  };
});
