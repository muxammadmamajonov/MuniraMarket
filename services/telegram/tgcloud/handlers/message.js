// @ts-check
/**
 * Telegram `message` update handler. Thin wrapper: all logic lives in `lib/bot/`.
 * - `/connect_orders[@bot]` (staff group): `lib/bot/connectOrders.js`
 * - `/start` (private chat): `lib/bot/start.js`
 * - a shared contact (private chat): `lib/bot/contact.js`
 * Every other message is ignored.
 */
import { api, db, fetch } from 'sdk';
import { handleConnectOrders } from '../lib/bot/connectOrders.js';
import { handleContact } from '../lib/bot/contact.js';
import { handleMessage } from '../lib/bot/start.js';

/**
 * @param {any} message Telegram Message
 */
export default async function (message) {
  const deps = { api, db, fetch };
  const connect = await handleConnectOrders(message, deps);
  if (connect.handled) return connect;
  if (message?.contact) return handleContact(message, deps);
  return handleMessage(message, deps);
}
