// @ts-check
/**
 * `/start` flow, written as a pure function over injected dependencies so it is unit-testable.
 * The platform entry point is `handlers/message.js`, a thin wrapper around `handleMessage`.
 *
 * Language is ONE preference in the Core API (`users.language`). On the first `/start` (the
 * API says `language_confirmed: false`) the bot asks once with two buttons; the choice is saved
 * by `lib/bot/onboarding.js` and later `/start`s greet in the saved language without asking.
 * If the Core API is unreachable the bot still greets, in the Telegram app language.
 *
 * `/start phone` (the shop's "verify your number" link) asks for the user's own contact with a
 * `request_contact` button; `lib/bot/contact.js` stores it.
 */
import { LANGUAGE_BUTTONS, languagePrompt, messagesFor, pickLocale } from '../i18n.js';
import { describeError, displayName, loadBotContext, readBotUser } from './context.js';

export { describeError } from './context.js';

// /start, /start@botname, /start <payload>
const START_RE = /^\/start(?:@[A-Za-z0-9_]{1,64})?(?:[ \t]+(\S+))?[ \t]*$/;
// Deep-link start parameters may only contain these characters (Bot API docs).
const PAYLOAD_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Payload of the shop's "verify your phone" deep link. */
export const PHONE_PAYLOAD = 'phone';
// callback_data is at most 64 bytes: `lang:uz:` + payload.
const MAX_CARRIED_PAYLOAD = 56;

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
    const suffix = payload && payload !== PHONE_PAYLOAD ? `=${payload}` : '';
    return {
      inline_keyboard: [
        [{ text: label, url: `https://t.me/${bot.botUsername}?startapp${suffix}` }],
      ],
    };
  }
  return null;
}

/**
 * The two-button language choice. The start payload rides along so a deep link survives it.
 * @param {string | null} payload
 */
export function buildLanguageKeyboard(payload) {
  const carried = payload && payload.length <= MAX_CARRIED_PAYLOAD ? `:${payload}` : '';
  return {
    inline_keyboard: [
      [
        { text: LANGUAGE_BUTTONS.uz, callback_data: `lang:uz${carried}` },
        { text: LANGUAGE_BUTTONS.ru, callback_data: `lang:ru${carried}` },
      ],
    ],
  };
}

/**
 * One-tap reply keyboard that shares the user's OWN number (Telegram asks for consent).
 * @param {import('../types.js').Locale} locale
 */
export function buildPhoneKeyboard(locale) {
  return {
    keyboard: [[{ text: messagesFor(locale).phoneButton, request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

/**
 * Personal greeting with the "open shop" button, in `locale`.
 * @param {import('./context.js').BotDeps} deps
 * @param {{ chatId: number, name: string, locale: import('../types.js').Locale, payload: string | null, bot: { miniAppUrl: string | null, botUsername: string | null } }} input
 */
export async function sendGreeting(deps, { chatId, name, locale, payload, bot }) {
  const text = messagesFor(locale);
  const keyboard = buildOpenShopKeyboard(bot, text.openShop, payload);
  if (!keyboard) {
    (deps.log ?? console).warn(
      'start: neither mini_app_url nor bot_username is configured; sending greeting without a button',
    );
  }
  await deps.api.sendMessage({
    chat_id: chatId,
    text: name ? text.personalGreeting(name) : text.startGreeting,
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
  return keyboard ? (bot.miniAppUrl ? 'web_app' : 'url') : 'none';
}

/**
 * Asks for the user's own phone number.
 * @param {import('./context.js').BotDeps} deps
 * @param {number} chatId
 * @param {import('../types.js').Locale} locale
 */
export async function sendPhoneRequest(deps, chatId, locale) {
  await deps.api.sendMessage({
    chat_id: chatId,
    text: messagesFor(locale).phoneRequest,
    reply_markup: buildPhoneKeyboard(locale),
  });
}

/**
 * Handles an incoming message. Only `/start` in a private chat is acted upon; everything else is
 * ignored.
 *
 * @param {any} message Telegram Message (`update.message`)
 * @param {import('./context.js').BotDeps} deps
 * @returns {Promise<{ handled: boolean, button: 'web_app' | 'url' | 'none' | 'language' | null }>}
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

  const { log, client, bot } = await loadBotContext(deps, 'start');

  // Best-effort user sync: a Core API outage must never stop the greeting.
  /** @type {import('./context.js').BotUser | null} */
  let user = null;
  if (client) {
    try {
      user = readBotUser(await client.syncTelegramUser(from));
    } catch (error) {
      log.warn('start: user sync skipped:', describeError(error));
    }
  }

  const name = displayName(from);

  // First start: ask once, in both languages. Only when the API positively says "not chosen".
  if (user?.languageConfirmed === false) {
    await deps.api.sendMessage({
      chat_id: chatId,
      text: languagePrompt(name || 'MuniraMarket'),
      reply_markup: buildLanguageKeyboard(command.payload),
    });
    return { handled: true, button: 'language' };
  }

  const locale = user?.language ?? pickLocale(from.language_code);
  if (command.payload === PHONE_PAYLOAD && user !== null && user.phoneVerified !== true) {
    await sendPhoneRequest(deps, chatId, locale);
    return { handled: true, button: 'none' };
  }
  const button = await sendGreeting(deps, {
    chatId,
    name,
    locale,
    payload: command.payload,
    bot,
  });
  return { handled: true, button };
}
