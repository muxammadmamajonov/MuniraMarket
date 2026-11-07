// @ts-check
/**
 * A shared contact in the private chat (the `request_contact` button, or the Mini App's
 * `requestContact()`, which Telegram delivers here as a contact message). Only the sender's OWN
 * contact (`contact.user_id === from.id`, both from the platform-verified update) is stored, as
 * the verified account phone. The number is never logged or echoed.
 */
import { messagesFor, pickLocale } from '../i18n.js';
import { describeError, loadBotContext, readBotUser } from './context.js';
import { buildOpenShopKeyboard, buildPhoneKeyboard } from './start.js';

/**
 * @param {any} message Telegram Message
 * @param {import('./context.js').BotDeps} deps
 * @returns {Promise<{ handled: boolean, verified?: boolean }>}
 */
export async function handleContact(message, deps) {
  const contact = message?.contact;
  const from = message?.from;
  const chatId = message?.chat?.id;
  if (!contact || !from || typeof from.id !== 'number' || from.is_bot) return { handled: false };
  if (typeof chatId !== 'number' || (message.chat.type && message.chat.type !== 'private')) {
    return { handled: false };
  }

  const { log, client, bot } = await loadBotContext(deps, 'contact');
  let locale = pickLocale(from.language_code);

  if (contact.user_id !== from.id || typeof contact.phone_number !== 'string') {
    await deps.api.sendMessage({
      chat_id: chatId,
      text: messagesFor(locale).phoneNotOwn,
      reply_markup: buildPhoneKeyboard(locale),
    });
    return { handled: true, verified: false };
  }

  let verified = false;
  if (client) {
    try {
      const user = readBotUser(await client.recordOwnPhone(from.id, contact.phone_number));
      verified = user?.phoneVerified === true;
      if (user?.language) locale = user.language;
    } catch (error) {
      log.warn('contact: phone not saved:', describeError(error));
    }
  }

  const text = messagesFor(locale);
  if (!verified) {
    await deps.api.sendMessage({ chat_id: chatId, text: text.genericError });
    return { handled: true, verified: false };
  }

  await deps.api.sendMessage({
    chat_id: chatId,
    text: text.phoneVerified,
    reply_markup: { remove_keyboard: true },
  });
  const keyboard = buildOpenShopKeyboard(bot, text.continueShopping, null);
  if (keyboard) {
    await deps.api.sendMessage({ chat_id: chatId, text: text.openShop, reply_markup: keyboard });
  }
  return { handled: true, verified: true };
}
