// @ts-check
/**
 * Mini App profile endpoint logic.
 *
 * Identity comes ONLY from the platform-verified `ctx.initData.user`. The endpoint `input` is
 * client-controlled and is never consulted for who the caller is.
 */
import { EndpointError } from 'sdk';
import { createCoreApiClient } from '../coreApi/client.js';
import { loadServiceConfig } from '../config.js';

export const PROFILE_UNAVAILABLE = 'PROFILE_UNAVAILABLE';

/**
 * Generic, internals-free refusal. The Mini App can branch on `parameters.code`.
 * @returns {EndpointError}
 */
function profileUnavailable() {
  return new EndpointError('Profile is temporarily unavailable', { code: PROFILE_UNAVAILABLE });
}

/**
 * @param {unknown} user
 * @returns {user is import('../types.js').TelegramUser}
 */
function isVerifiedUser(user) {
  if (typeof user !== 'object' || user === null) return false;
  const candidate = /** @type {Record<string, unknown>} */ (user);
  return (
    typeof candidate['id'] === 'number' &&
    Number.isSafeInteger(candidate['id']) &&
    candidate['id'] > 0 &&
    typeof candidate['first_name'] === 'string'
  );
}

/**
 * @param {unknown} _input ignored on purpose: client-controlled
 * @param {{ initData?: { user?: unknown } } | undefined} ctx platform context with verified init data
 * @param {{ coreApi: Pick<import('../types.js').CoreApiClient, 'syncTelegramUser'>, log?: import('../types.js').Logger }} deps
 * @returns {Promise<{ user: unknown }>}
 */
export async function getProfile(_input, ctx, deps) {
  const log = deps.log ?? console;
  const user = ctx?.initData?.user;
  if (!isVerifiedUser(user)) {
    log.warn('getProfile: verified init data has no usable user');
    throw profileUnavailable();
  }

  let response;
  try {
    response = await deps.coreApi.syncTelegramUser(user);
  } catch (error) {
    const extra = /** @type {{ name?: string, code?: unknown, status?: unknown }} */ (error);
    log.error(
      'getProfile: Core API call failed:',
      extra?.name ?? 'Error',
      `status=${String(extra?.status)}`,
      `code=${String(extra?.code)}`,
    );
    throw profileUnavailable();
  }

  if (typeof response !== 'object' || response === null || !('user' in response)) {
    log.error('getProfile: Core API response has no user');
    throw profileUnavailable();
  }
  return { user: /** @type {{ user: unknown }} */ (response).user };
}

/**
 * Production wiring: builds the signed Core API client from `service_config`.
 *
 * @param {unknown} input
 * @param {{ initData?: { user?: unknown } } | undefined} ctx
 * @param {{ db: import('../config.js').ConfigDb, fetch: import('../coreApi/client.js').FetchLike, log?: import('../types.js').Logger, now?: () => number, nonce?: () => string }} deps
 */
export async function getProfileWithConfig(input, ctx, deps) {
  const log = deps.log ?? console;
  /** @type {import('../types.js').CoreApiClient} */
  let coreApi;
  try {
    const config = await loadServiceConfig(deps.db);
    coreApi = createCoreApiClient({
      fetch: deps.fetch,
      config,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.nonce ? { nonce: deps.nonce } : {}),
    });
  } catch (error) {
    // ConfigError messages name the key only, never a value.
    log.error('getProfile: service config unavailable:', /** @type {Error} */ (error).message);
    throw profileUnavailable();
  }
  return getProfile(input, ctx, { coreApi, log });
}
