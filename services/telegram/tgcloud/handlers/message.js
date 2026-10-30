// @ts-check
/**
 * Telegram `message` update handler. Thin wrapper: all logic lives in `lib/bot/start.js`.
 * Handles `/start` (with or without a payload); every other message is ignored.
 */
import { api, db, fetch } from 'sdk';
import { handleMessage } from '../lib/bot/start.js';

/**
 * @param {any} message Telegram Message
 */
export default async function (message) {
  return handleMessage(message, { api, db, fetch });
}
