import { bindings, defineConfig, defineContainer, exports } from 'cf/config';
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
        REDIS_URL: bindings.secret(),
        SERVICE_AUTH_KEYS: bindings.secret(),
        TELEGRAM_BOT_TOKEN: bindings.secret(),

        // --- plain container configuration ---
        APP_ENV: bindings.text(target.appEnv),
        APP_RELEASE: bindings.text(process.env['APP_RELEASE']?.trim() ?? ''),
        LOG_LEVEL: bindings.text('INFO'),
        TELEGRAM_ENVIRONMENT: bindings.text('production'),
        TELEGRAM_LOGIN_WIDGET_ENABLED: bindings.text('true'),
        // Set per environment as plain variables at deploy time (not secret, not committed):
        // TELEGRAM_BOT_ID, TELEGRAM_BOT_USERNAME, CSRF_TRUSTED_ORIGINS.
        TELEGRAM_BOT_ID: bindings.text(process.env['MM_TELEGRAM_BOT_ID']?.trim() ?? ''),
        TELEGRAM_BOT_USERNAME: bindings.text(process.env['MM_TELEGRAM_BOT_USERNAME']?.trim() ?? ''),
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
