// @ts-check
/**
 * The first-start language buttons (`callback_data` `lang:<uz|ru>[:<start payload>]`). Saves the
 * choice in the Core API (the one language preference), then greets in that language.
 * Platform entry point: `handlers/callback_query.js`.
 */
import { messagesFor } from '../i18n.js';
import { describeError, displayName, loadBotContext, readBotUser } from './context.js';
import { PHONE_PAYLOAD, sendGreeting, sendPhoneRequest } from './start.js';

const LANG_RE = /^lang:(uz|ru)(?::([A-Za-z0-9_-]{1,56}))?$/;

/**
 * @param {unknown} data
 * @returns {{ language: 'uz' | 'ru', payload: string | null } | null}
 */
export function parseLanguageCallback(data) {
  if (typeof data !== 'string') return null;
  const match = LANG_RE.exec(data);
  if (!match) return null;
  return { language: /** @type {'uz' | 'ru'} */ (match[1]), payload: match[2] ?? null };
}

/**
 * @param {any} query Telegram CallbackQuery
 * @param {import('./context.js').BotDeps} deps
 * @returns {Promise<{ handled: boolean, saved?: boolean }>}
 */
export async function handleCallbackQuery(query, deps) {
  const parsed = parseLanguageCallback(query?.data);
  const from = query?.from;
  const chat = query?.message?.chat;
  if (!parsed || !from || typeof from.id !== 'number' || from.is_bot) return { handled: false };
  if (!chat || typeof chat.id !== 'number' || (chat.type && chat.type !== 'private')) {
    return { handled: false };
  }

  const { log, client, bot } = await loadBotContext(deps, 'onboarding');
  const text = messagesFor(parsed.language);

  /** @type {import('./context.js').BotUser | null} */
  let user = null;
  let saved = false;
  if (client) {
    try {
      user = readBotUser(await client.setLanguage(from.id, parsed.language));
      saved = true;
    } catch (error) {
      log.warn('onboarding: language not saved:', describeError(error));
    }
  }

  // Always stop the button spinner; say plainly when saving failed so the user can tap again.
  try {
    await deps.api.answerCallbackQuery({
      callback_query_id: query.id,
      ...(saved ? {} : { text: text.genericError }),
    });
  } catch (error) {
    log.warn('onboarding: answerCallbackQuery failed:', describeError(error));
  }
  if (!saved) return { handled: true, saved: false };

  // Replace the bilingual prompt with a short confirmation (no buttons left to tap twice).
  const messageId = query.message?.message_id;
  if (typeof messageId === 'number') {
    try {
      await deps.api.editMessageText({
        chat_id: chat.id,
        message_id: messageId,
        text: text.languageSaved,
      });
    } catch (error) {
      log.warn('onboarding: prompt not edited:', describeError(error));
    }
  }

  if (parsed.payload === PHONE_PAYLOAD && user?.phoneVerified !== true) {
    await sendPhoneRequest(deps, chat.id, parsed.language);
  } else {
    await sendGreeting(deps, {
      chatId: chat.id,
      name: displayName(from),
      locale: parsed.language,
      payload: parsed.payload,
      bot,
    });
  }
  return { handled: true, saved: true };
}
