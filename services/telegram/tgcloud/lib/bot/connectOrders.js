// @ts-check
/**
 * `/connect_orders`: an admin sends it inside the staff group to make that group receive order
 * alerts (`order.staff_alert` outbox events). The Core API decides whether the SENDER is an admin
 * and stores the group chat id in its own PostgreSQL; nothing is stored in the Serverless DB.
 *
 * Identity comes only from the platform-delivered update (`message.from.id`, `message.chat`),
 * never from the message text. Replies never echo the chat id, tokens or the Core API response,
 * and logs carry only error classes/status codes (see `describeError`).
 */
import { createCoreApiClient } from '../coreApi/client.js';
import { CoreApiError } from '../coreApi/errors.js';
import { parseBotConfig, parseServiceConfig, readConfigRows } from '../config.js';
import { STAFF_MESSAGES } from '../i18n.js';
import { describeError } from './start.js';

/** Telegram's GroupAnonymousBot: the `from` of messages sent by an anonymous group admin. */
export const GROUP_ANONYMOUS_BOT_ID = 1087968824;

// /connect_orders or /connect_orders@bot_username, optionally followed by ignored arguments.
const COMMAND_RE = /^\/connect_orders(?:@([A-Za-z0-9_]{1,64}))?(?:\s[\s\S]*)?$/i;
const COMMAND_NAME_RE = /^\/connect_orders(?:@|\s|$)/;

/**
 * @typedef {object} ConnectOrdersDeps
 * @property {{ sendMessage: (params: Record<string, unknown>) => Promise<unknown>, getMe?: () => Promise<unknown> }} api SDK `api`
 * @property {import('../config.js').ConfigDb} db SDK `db`
 * @property {import('../coreApi/client.js').FetchLike} fetch SDK `fetch`
 * @property {import('../types.js').Logger} [log] defaults to `console`
 * @property {() => number} [now]
 * @property {() => string} [nonce]
 * @property {number} [timeoutMs]
 */

/**
 * @typedef {'connected' | 'forbidden' | 'failed' | 'group_only' | 'anonymous' | 'ignored'} ConnectOrdersOutcome
 */

/**
 * Parses `/connect_orders[@bot]`. The command name is case-sensitive (Telegram commands are
 * lowercase); the bot username is compared case-insensitively by the caller.
 *
 * @param {unknown} text
 * @returns {{ mention: string | null } | null} null when `text` is not this command
 */
export function parseConnectOrdersCommand(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!COMMAND_NAME_RE.test(trimmed)) return null;
  const match = COMMAND_RE.exec(trimmed);
  if (!match) return null;
  return { mention: match[1] ?? null };
}

/**
 * Our own username: the configured `bot_username`, else `getMe` (best effort), else null.
 * @param {ConnectOrdersDeps} deps
 * @param {Record<string, string>} rows
 * @returns {Promise<string | null>}
 */
async function ownUsername(deps, rows) {
  const configured = parseBotConfig(rows).botUsername;
  if (configured) return configured;
  if (typeof deps.api.getMe !== 'function') return null;
  try {
    const me = /** @type {{ username?: unknown } | null} */ (await deps.api.getMe());
    return typeof me?.username === 'string' ? me.username : null;
  } catch {
    return null;
  }
}

/**
 * Replies in the same chat, as a reply to the command when possible. A failed reply is logged
 * (error class only) and swallowed: there is nobody else to tell.
 * @param {ConnectOrdersDeps} deps
 * @param {any} message
 * @param {string} text
 */
async function reply(deps, message, text) {
  const messageId = message?.message_id;
  try {
    await deps.api.sendMessage({
      chat_id: message.chat.id,
      text,
      ...(Number.isSafeInteger(messageId)
        ? { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } }
        : {}),
    });
  } catch (error) {
    (deps.log ?? console).warn('connect_orders: reply failed:', describeError(error));
  }
}

/**
 * Handles `/connect_orders`. Returns `handled: false` for anything that is not this command (or is
 * addressed to another bot), so the caller can pass the message on.
 *
 * @param {any} message Telegram Message (`update.message`)
 * @param {ConnectOrdersDeps} deps
 * @returns {Promise<{ handled: boolean, outcome: ConnectOrdersOutcome }>}
 */
export async function handleConnectOrders(message, deps) {
  /** @type {{ handled: boolean, outcome: ConnectOrdersOutcome }} */
  const ignored = { handled: false, outcome: 'ignored' };
  const command = parseConnectOrdersCommand(message?.text);
  if (!command) return ignored;

  const chat = message?.chat;
  const from = message?.from;
  if (!chat || typeof chat.id !== 'number' || !Number.isSafeInteger(chat.id)) return ignored;

  const log = deps.log ?? console;

  /** @type {Record<string, string>} */
  let rows = {};
  try {
    rows = await readConfigRows(deps.db);
  } catch (error) {
    log.error('connect_orders: could not read service_config:', describeError(error));
  }

  if (command.mention !== null) {
    const own = await ownUsername(deps, rows);
    // Unknown own username: the platform delivered the update to us, so treat it as ours.
    if (own !== null && own.toLowerCase() !== command.mention.toLowerCase()) return ignored;
  }

  if (chat.type !== 'group' && chat.type !== 'supergroup') {
    if (chat.type === 'private') {
      await reply(deps, message, STAFF_MESSAGES.connectOrders.groupOnly);
      return { handled: true, outcome: 'group_only' };
    }
    return ignored; // channels and anything unknown
  }

  // Anonymous admins and channel posts carry no personal identity to authorise.
  if (message.sender_chat || (from && from.id === GROUP_ANONYMOUS_BOT_ID)) {
    await reply(deps, message, STAFF_MESSAGES.connectOrders.anonymous);
    return { handled: true, outcome: 'anonymous' };
  }
  if (!from || typeof from.id !== 'number' || from.is_bot) return ignored;

  /** @type {ConnectOrdersOutcome} */
  let outcome;
  try {
    const client = createCoreApiClient({
      fetch: deps.fetch,
      config: parseServiceConfig(rows),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.nonce ? { nonce: deps.nonce } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    });
    const response = /** @type {{ connected?: unknown } | null} */ (
      await client.connectStaffChat({
        actorTelegramUserId: from.id,
        chatId: chat.id,
        chatType: chat.type,
      })
    );
    if (response?.connected === true) {
      outcome = 'connected';
    } else {
      log.warn('connect_orders: unexpected Core API response shape');
      outcome = 'failed';
    }
  } catch (error) {
    if (error instanceof CoreApiError && error.status === 403) {
      outcome = 'forbidden';
    } else {
      log.warn('connect_orders: not connected:', describeError(error));
      outcome = 'failed';
    }
  }

  const texts = STAFF_MESSAGES.connectOrders;
  await reply(
    deps,
    message,
    outcome === 'connected'
      ? texts.connected
      : outcome === 'forbidden'
        ? texts.forbidden
        : texts.failed,
  );
  return { handled: true, outcome };
}
