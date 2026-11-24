import { WorkerEntrypoint } from 'cloudflare:workers';
import { forward, type ForwardDeps, log } from './forward';
import { runScheduledTick } from './scheduler';

/**
 * Core API gateway: the only way into the Core API Neon Function (`coreapi`, README.md).
 *
 * - `default.fetch`: the public hostname. Health checks and the two Telegram Serverless routes.
 * - `StorefrontApi` / `AdminApi`: named entrypoints, reachable only through the web and admin
 *   Workers' service bindings (they have no route of their own).
 * - `default.scheduled`: the Cron Trigger. It only signs two POSTs (outbox drain, cleanup); the
 *   batch work runs in the Function next to Postgres (src/scheduler.ts).
 *
 * The Function URL (`CORE_API_FUNCTION_ORIGIN`) and the shared secret (`CORE_API_FUNCTION_SECRET`)
 * are Worker secrets: neither ever reaches a browser, and any `X-MM-Gateway-Secret` a caller sends
 * is dropped by the header allow-list before the gateway writes its own.
 */

function forwardDeps(env: Env): ForwardDeps {
  return { env, fetch: (request) => fetch(request) };
}

/** Reachable only through the web Worker's service binding (`CORE_API`). */
export class StorefrontApi extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    return forward(request, forwardDeps(this.env), 'storefront');
  }
}

/** Reachable only through the admin Worker's service binding (`CORE_API`). */
export class AdminApi extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    return forward(request, forwardDeps(this.env), 'admin');
  }
}

export default {
  fetch(request, env) {
    return forward(request, forwardDeps(env), 'public');
  },

  /**
   * Cron Trigger (every minute, deployed modes only; cloudflare.config.ts). Signs and forwards
   * the outbox drain and, every 15th minute, the cleanup, through the in-process `scheduler`
   * entrance. Nothing heavy runs here (Free plan: 10 ms CPU per invocation): waiting on the
   * Function is wall-clock time, not CPU. `runScheduledTick` never rejects.
   */
  async scheduled(controller, env, ctx) {
    const tick = runScheduledTick({
      env,
      scheduledTime: controller.scheduledTime,
      forward: (request) => forward(request, forwardDeps(env), 'scheduler'),
      log,
    });
    ctx.waitUntil(tick);
    await tick;
  },
} satisfies ExportedHandler<Env>;
