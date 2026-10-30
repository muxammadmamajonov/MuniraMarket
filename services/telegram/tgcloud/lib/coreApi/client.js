// @ts-check
/**
 * Signed HTTP client for the Core API internal routes (ADR 0003).
 *
 * - The request body is serialised ONCE to bytes; those exact bytes are signed and sent.
 * - The signed path is, byte for byte, the path appended to the base URL.
 * - Failures surface as `CoreApiError` carrying only a status and a stable code. Response bodies
 *   are parsed on success but are never copied into errors, logs or messages.
 */
import { utf8Encode } from '../crypto/index.js';
import { parseHttpUrl } from '../url.js';
import { CoreApiError, codeForStatus } from './errors.js';
import { generateNonce } from './nonce.js';
import { isSafeRequestPath } from './path.js';
import { signRequest } from './signer.js';

export const DEFAULT_TIMEOUT_MS = 8000;
const SESSION_PATH = '/api/v1/internal/telegram/session';
const ME_PATH = '/api/v1/internal/telegram/me';
const NOTIFICATIONS_PATH = '/api/v1/internal/telegram/notifications';
const MAX_TELEGRAM_ID = 2 ** 52;
const MAX_CLAIM_LIMIT = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTIFICATION_OUTCOMES = Object.freeze(['delivered', 'recipient_blocked', 'retry', 'failed']);
const ERROR_CODE_RE = /^[a-z0-9_.-]{1,64}$/;

/**
 * Subset of the SDK `fetch` that we rely on.
 * @typedef {(url: string, init?: { method?: string, headers?: Record<string, string>, body?: Uint8Array | string, signal?: AbortSignal }) => Promise<{ ok: boolean, status: number, text: () => Promise<string> }>} FetchLike
 */

/**
 * @param {string} path
 */
function assertPath(path) {
  if (!isSafeRequestPath(path)) throw new TypeError('Invalid Core API path');
}

/**
 * @param {import('../types.js').ServiceConfig} config
 * @returns {string} origin without a trailing slash
 */
function originOf(config) {
  const parsed = parseHttpUrl(config.baseUrl);
  if (!parsed || (parsed.path !== '' && parsed.path !== '/')) {
    throw new TypeError('Invalid Core API base URL');
  }
  return `${parsed.scheme}://${parsed.host}${parsed.port === '' ? '' : `:${parsed.port}`}`;
}

/**
 * @param {number} id
 */
function assertTelegramUserId(id) {
  if (!Number.isSafeInteger(id) || id <= 0 || id > MAX_TELEGRAM_ID) {
    throw new TypeError('Invalid Telegram user id');
  }
}

/**
 * @param {unknown} id
 * @returns {string}
 */
function assertUuid(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new TypeError('Invalid message id');
  return id;
}

/**
 * @param {object} deps
 * @param {FetchLike} deps.fetch the SDK `fetch` (or a test double)
 * @param {import('../types.js').ServiceConfig} deps.config
 * @param {() => number} [deps.now] epoch milliseconds
 * @param {() => string} [deps.nonce]
 * @param {number} [deps.timeoutMs] applied only when AbortController and setTimeout exist
 * @returns {import('../types.js').CoreApiClient}
 */
export function createCoreApiClient({
  fetch,
  config,
  now = Date.now,
  nonce = generateNonce,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const origin = originOf(config);

  /**
   * @param {string} method
   * @param {string} path path with optional query string, e.g. `/api/v1/internal/x?a=1`
   * @param {{ actorTelegramUserId?: number, json?: unknown }} [options]
   * @returns {Promise<unknown>} parsed JSON body (null for an empty body)
   */
  async function request(method, path, options = {}) {
    assertPath(path);
    const actor =
      options.actorTelegramUserId === undefined
        ? ''
        : (assertTelegramUserId(options.actorTelegramUserId), `tg:${options.actorTelegramUserId}`);

    /** @type {Uint8Array | undefined} */
    let body;
    if (options.json !== undefined) {
      const serialized = JSON.stringify(options.json);
      // JSON.stringify output is well-formed Unicode, so these bytes are exactly what is signed
      // and exactly what is sent.
      body = utf8Encode(serialized);
    }

    const signatureHeaders = signRequest({
      keyId: config.keyId,
      secret: config.secret,
      method,
      pathWithQuery: path,
      actor,
      body: body ?? null,
      timestamp: Math.floor(now() / 1000),
      nonce: nonce(),
    });

    /** @type {Record<string, string>} */
    const headers = { Accept: 'application/json', ...signatureHeaders };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    /** @type {{ method: string, headers: Record<string, string>, body?: Uint8Array, signal?: AbortSignal }} */
    const init = { method: method.toUpperCase(), headers };
    if (body !== undefined) init.body = body;

    // Timeouts are best-effort: the SDK documents neither AbortController nor setTimeout, so we
    // use them only when present. If the runtime's fetch ignores `signal`, no timeout applies.
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    let timedOut = false;
    if (
      timeoutMs > 0 &&
      typeof AbortController !== 'undefined' &&
      typeof setTimeout !== 'undefined'
    ) {
      const controller = new AbortController();
      init.signal = controller.signal;
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    }

    let response;
    let text;
    try {
      response = await fetch(`${origin}${path}`, init);
      text = await response.text();
    } catch {
      throw new CoreApiError(0, timedOut ? 'TIMEOUT' : 'NETWORK_ERROR');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (!response.ok) throw new CoreApiError(response.status, codeForStatus(response.status));

    if (text.trim() === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new CoreApiError(response.status, 'INVALID_RESPONSE');
    }
  }

  return {
    request,

    /**
     * Upserts the Telegram user in the Core API and returns its response.
     * @param {import('../types.js').TelegramUser} user verified Telegram user
     */
    syncTelegramUser(user) {
      assertTelegramUserId(user.id);
      return request('POST', SESSION_PATH, {
        actorTelegramUserId: user.id,
        json: {
          telegram_user_id: user.id,
          first_name: user.first_name,
          last_name: user.last_name ?? null,
          username: user.username ?? null,
          language_code: user.language_code ?? null,
        },
      });
    },

    /**
     * @param {number} telegramUserId
     */
    getMe(telegramUserId) {
      return request('GET', ME_PATH, { actorTelegramUserId: telegramUserId });
    },

    /**
     * Leases up to `limit` due notification outbox messages (ADR 0008). A service call: signed
     * with an EMPTY actor, because draining acts for the service, never for a user. The Core API
     * answers `{ items, lease_expires_at }`; the result is returned unvalidated (the drain adapter
     * validates it).
     * @param {{ limit: number }} options integer 1..50
     */
    async claimNotifications({ limit }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CLAIM_LIMIT) {
        throw new TypeError('Invalid claim limit');
      }
      return request('POST', `${NOTIFICATIONS_PATH}/claim`, { json: { limit } });
    },

    /**
     * Reports what happened to one claimed message. Resolves with null on success (HTTP 204);
     * rejects with `CoreApiError` (404 `NOT_FOUND` when unknown, finished, or not claimed).
     * @param {string} id outbox message UUID
     * @param {{ outcome: import('../types.js').NotificationOutcome, errorCode?: string }} result
     */
    async reportNotification(id, { outcome, errorCode }) {
      assertUuid(id);
      if (!NOTIFICATION_OUTCOMES.includes(outcome)) throw new TypeError('Invalid outcome');
      /** @type {{ outcome: string, error_code?: string }} */
      const json = { outcome };
      if (errorCode !== undefined) {
        if (typeof errorCode !== 'string' || !ERROR_CODE_RE.test(errorCode)) {
          throw new TypeError('Invalid error code');
        }
        json.error_code = errorCode;
      }
      await request('POST', `${NOTIFICATIONS_PATH}/${id}/result`, { json });
      return null;
    },
  };
}
