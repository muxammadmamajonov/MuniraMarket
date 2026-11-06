import { BotApiError } from './telegramSdk';

/**
 * Minimal Telegram Bot API client for the Cron Trigger: exactly the `api` surface that
 * `createTelegramBotTransport` (services/telegram/tgcloud/lib/notifications/transport.js) uses,
 * i.e. `sendMessage`.
 *
 * Failures follow the Serverless SDK contract the transport expects: a Bot API error (`ok: false`
 * or a 4xx/5xx answer) rejects with `BotApiError` carrying the numeric `error_code`; anything else
 * (network, timeout, unreadable answer) rejects with a plain `Error`, which the transport treats
 * as a transient `transport_error`. No error, message or log ever contains the bot token, the
 * request URL (which embeds the token) or the Bot API description.
 */

const BOT_API_ORIGIN = 'https://api.telegram.org';
export const BOT_API_TIMEOUT_MS = 10_000;

export interface BotApi {
  sendMessage(params: Record<string, unknown>): Promise<unknown>;
}

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only `retry_after` / `migrate_to_chat_id`-style numbers survive; never strings. */
function numericParameters(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'number' && Number.isFinite(item)) out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function createBotApi(token: string, fetchFn: FetchFn): BotApi {
  if (token.trim() === '') throw new TypeError('Bot token is not configured');

  async function call(method: string, params: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchFn(`${BOT_API_ORIGIN}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(BOT_API_TIMEOUT_MS),
      });
    } catch {
      // The underlying error may quote the URL, and the URL contains the token.
      throw new Error(`Bot API ${method} request failed`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null; // not JSON: classified by the HTTP status below
    }

    if (response.ok && isRecord(body) && body['ok'] === true) return body['result'];

    const errorCode = isRecord(body) ? body['error_code'] : undefined;
    const code =
      typeof errorCode === 'number' && Number.isInteger(errorCode) && errorCode >= 400
        ? errorCode
        : response.status;
    if (code >= 400) {
      throw new BotApiError(
        code,
        method,
        isRecord(body) ? numericParameters(body['parameters']) : undefined,
      );
    }
    throw new Error(`Bot API ${method} returned an unexpected response`);
  }

  return {
    sendMessage: (params) => call('sendMessage', params),
  };
}
