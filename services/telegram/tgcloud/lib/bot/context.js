// @ts-check
/**
 * Shared per-update setup for bot handlers: service config, a signed Core API client and the
 * user record the Core API returns. Every failure degrades to `null`; handlers keep replying.
 */
import { createCoreApiClient } from '../coreApi/client.js';
import { ConfigError, parseBotConfig, parseServiceConfig, readConfigRows } from '../config.js';

/**
 * The Bot API methods handlers use (SDK `api`).
 * @typedef {object} BotApi
 * @property {(params: Record<string, unknown>) => Promise<unknown>} sendMessage
 * @property {(params: Record<string, unknown>) => Promise<unknown>} answerCallbackQuery
 * @property {(params: Record<string, unknown>) => Promise<unknown>} editMessageText
 * @property {(params: Record<string, unknown>) => Promise<unknown>} deleteMessage
 */

/**
 * @typedef {object} BotDeps
 * @property {BotApi} api SDK `api`
 * @property {import('../config.js').ConfigDb} db SDK `db`
 * @property {import('../coreApi/client.js').FetchLike} fetch SDK `fetch`
 * @property {import('../types.js').Logger} [log]
 * @property {() => number} [now]
 * @property {() => string} [nonce]
 * @property {number} [timeoutMs]
 */

/**
 * The user fields the bot relies on, read defensively from a Core API `{ user }` envelope.
 * @typedef {object} BotUser
 * @property {'uz' | 'ru' | null} language
 * @property {boolean | null} languageConfirmed null when the API did not say
 * @property {boolean | null} phoneVerified
 */

/**
 * Logs an error without ever including secrets or response bodies.
 * @param {unknown} error
 * @returns {string}
 */
export function describeError(error) {
  if (error instanceof ConfigError) return error.message;
  if (error instanceof Error) {
    const extra = /** @type {{ code?: unknown, status?: unknown }} */ (error);
    const parts = [error.name];
    if (typeof extra.status === 'number') parts.push(`status=${extra.status}`);
    if (typeof extra.code === 'string' || typeof extra.code === 'number') {
      parts.push(`code=${String(extra.code)}`);
    }
    return parts.join(' ');
  }
  return 'non-error thrown';
}

/**
 * @param {unknown} envelope
 * @returns {BotUser | null}
 */
export function readBotUser(envelope) {
  const user = /** @type {{ user?: Record<string, unknown> } | null} */ (envelope)?.user;
  if (!user || typeof user !== 'object') return null;
  const language = user['language'] === 'uz' || user['language'] === 'ru' ? user['language'] : null;
  const flag = (/** @type {unknown} */ value) => (typeof value === 'boolean' ? value : null);
  return {
    language,
    languageConfirmed: flag(user['language_confirmed']),
    phoneVerified: flag(user['phone_verified']),
  };
}

/**
 * @param {BotDeps} deps
 * @param {string} label for logs
 */
export async function loadBotContext(deps, label) {
  const log = deps.log ?? console;
  /** @type {Record<string, string>} */
  let rows = {};
  try {
    rows = await readConfigRows(deps.db);
  } catch (error) {
    log.error(`${label}: could not read service_config:`, describeError(error));
  }

  /** @type {import('../types.js').CoreApiClient | null} */
  let client = null;
  try {
    client = createCoreApiClient({
      fetch: deps.fetch,
      config: parseServiceConfig(rows),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.nonce ? { nonce: deps.nonce } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    });
  } catch (error) {
    log.warn(`${label}: Core API not configured:`, describeError(error));
  }

  const bot = parseBotConfig(rows);
  for (const warning of bot.warnings) log.warn(`${label}: ${warning}`);
  return { log, client, bot };
}

/**
 * Display name for greetings: the Telegram first name, trimmed to a sane length.
 * @param {{ first_name?: unknown }} from
 */
export function displayName(from) {
  const raw = typeof from.first_name === 'string' ? from.first_name.trim() : '';
  const chars = Array.from(raw);
  return chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : raw;
}
