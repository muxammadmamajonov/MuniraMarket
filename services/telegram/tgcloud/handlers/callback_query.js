// @ts-check
/**
 * Telegram `callback_query` update handler. Thin wrapper: the first-start language buttons
 * (`lib/bot/onboarding.js`). Other callback data is ignored.
 */
import { api, db, fetch } from 'sdk';
import { handleCallbackQuery } from '../lib/bot/onboarding.js';

/**
 * @param {any} query Telegram CallbackQuery
 */
export default async function (query) {
  return handleCallbackQuery(query, { api, db, fetch });
}
