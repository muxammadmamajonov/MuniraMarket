// @ts-check
/**
 * A shared contact in the private chat. The main path is the Mini App profile's "share my number"
 * (`WebApp.requestContact()`, which Telegram delivers here as a contact message); the
 * `request_contact` button after `/start phone` is the fallback for browser users. Only the sender's OWN
 * contact (`contact.user_id === from.id`, both from the platform-verified update) is stored, as
 * the verified account phone. The number is never logged or echoed, and once it is recorded the
 * shared contact message itself is deleted from the chat (best effort: a failure is logged without
 * the number and the confirmation is still sent).
 */
import { messagesFor, pickLocale } from '../i18n.js';
import { describeError, loadBotContext, readBotUser } from './context.js';
import { buildPhoneKeyboard } from './start.js';

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

  const { log, client } = await loadBotContext(deps, 'contact');
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

  // The number is stored; the contact card need not stay in the chat history.
  if (typeof message.message_id === 'number') {
    try {
      await deps.api.deleteMessage({ chat_id: chatId, message_id: message.message_id });
    } catch (error) {
      log.warn('contact: shared contact message not deleted:', describeError(error));
    }
  }

  await deps.api.sendMessage({
    chat_id: chatId,
    text: text.phoneVerified,
    reply_markup: { remove_keyboard: true },
  });
  // One short confirmation only: usually the user shared from the Mini App profile and is still
  // there; the profile picks up the verified number by itself.
  return { handled: true, verified: true };
}
