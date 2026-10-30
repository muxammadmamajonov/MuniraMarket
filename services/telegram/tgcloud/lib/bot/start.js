// @ts-check
/**
 * `/start` flow, written as a pure function over injected dependencies so it is unit-testable.
 * The platform entry point is `handlers/message.js`, a thin wrapper around `handleMessage`.
 */
import { createCoreApiClient } from '../coreApi/client.js';
import { ConfigError, parseBotConfig, parseServiceConfig, readConfigRows } from '../config.js';
import { messagesFor, pickLocale } from '../i18n.js';

// /start, /start@botname, /start <payload>
const START_RE = /^\/start(?:@[A-Za-z0-9_]{1,64})?(?:[ \t]+(\S+))?[ \t]*$/;
// Deep-link start parameters may only contain these characters (Bot API docs).
const PAYLOAD_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * @typedef {object} StartDeps
 * @property {{ sendMessage: (params: Record<string, unknown>) => Promise<unknown> }} api SDK `api`
 * @property {import('../config.js').ConfigDb} db SDK `db`
 * @property {import('../coreApi/client.js').FetchLike} fetch SDK `fetch`
 * @property {import('../types.js').Logger} [log] defaults to `console`
 * @property {() => number} [now]
 * @property {() => string} [nonce]
 * @property {number} [timeoutMs]
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
 * Parses a `/start` command.
 * @param {string | undefined} text
 * @returns {{ payload: string | null } | null} null when `text` is not a /start command
 */
export function parseStartCommand(text) {
  if (typeof text !== 'string') return null;
  const match = START_RE.exec(text.trim());
  if (!match) return null;
  const rawPayload = match[1];
  return { payload: rawPayload !== undefined && PAYLOAD_RE.test(rawPayload) ? rawPayload : null };
}

/**
 * Builds the inline keyboard that opens the Main Mini App, or null when it cannot be built.
 *
 * @param {{ miniAppUrl: string | null, botUsername: string | null }} bot
 * @param {string} label
 * @param {string | null} payload
 * @returns {{ inline_keyboard: Array<Array<Record<string, unknown>>> } | null}
 */
export function buildOpenShopKeyboard(bot, label, payload) {
  if (bot.miniAppUrl) {
    return { inline_keyboard: [[{ text: label, web_app: { url: bot.miniAppUrl } }]] };
  }
  if (bot.botUsername) {
    const suffix = payload ? `=${payload}` : '';
    return {
      inline_keyboard: [
        [{ text: label, url: `https://t.me/${bot.botUsername}?startapp${suffix}` }],
      ],
    };
  }
  return null;
}

/**
 * Handles an incoming message. Only `/start` in a private chat is acted upon; everything else is
 * ignored.
 *
 * @param {any} message Telegram Message (`update.message`)
 * @param {StartDeps} deps
 * @returns {Promise<{ handled: boolean, button: 'web_app' | 'url' | 'none' | null }>}
 */
export async function handleMessage(message, deps) {
  const ignored = { handled: false, button: null };
  const command = parseStartCommand(message?.text);
  if (!command) return ignored;

  const chatId = message?.chat?.id;
  const from = message?.from;
  if (typeof chatId !== 'number' || !from || typeof from.id !== 'number' || from.is_bot) {
    return ignored;
  }
  // Greet only in private chats; groups would otherwise get an unsolicited shop button.
  if (message.chat.type !== undefined && message.chat.type !== 'private') return ignored;

  const log = deps.log ?? console;
  const locale = pickLocale(from.language_code);
  const text = messagesFor(locale);

  /** @type {Record<string, string>} */
  let rows = {};
  try {
    rows = await readConfigRows(deps.db);
  } catch (error) {
    log.error('start: could not read service_config:', describeError(error));
  }

  // Best-effort user sync: a Core API outage must never stop the greeting.
  try {
    const config = parseServiceConfig(rows);
    const client = createCoreApiClient({
      fetch: deps.fetch,
      config,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.nonce ? { nonce: deps.nonce } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    });
    await client.syncTelegramUser(from);
  } catch (error) {
    log.warn('start: user sync skipped:', describeError(error));
  }

  const bot = parseBotConfig(rows);
  for (const warning of bot.warnings) log.warn(`start: ${warning}`);

  const keyboard = buildOpenShopKeyboard(bot, text.openShop, command.payload);
  if (!keyboard) {
    log.warn(
      'start: neither mini_app_url nor bot_username is configured; sending greeting without a button',
    );
  }

  await deps.api.sendMessage({
    chat_id: chatId,
    text: text.startGreeting,
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });

  return {
    handled: true,
    button: keyboard ? (bot.miniAppUrl ? 'web_app' : 'url') : 'none',
  };
}
