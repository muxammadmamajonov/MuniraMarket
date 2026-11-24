/**
 * Stand-in for the Telegram Serverless `sdk` module (port of
 * services/api-gateway/src/telegramSdk.ts). The shared notification code reused from
 * `services/telegram/tgcloud/lib/` imports exactly one thing from `sdk`: `BotApiError`, to classify
 * Bot API failures with `instanceof`. tsconfig `paths` and the Vitest alias map `sdk` here, so the
 * transport recognises the errors thrown by our own Bot API adapter (`./botApi.ts`).
 */
export class BotApiError extends Error {
  /** Bot API `error_code` (or the HTTP status when the body had none). */
  readonly code: number;
  /** Always empty: Bot API descriptions can echo chat data, so they are never kept. */
  readonly description: string;
  /** Bot API method that failed. */
  readonly method: string;
  readonly parameters?: Record<string, unknown>;

  constructor(code: number, method: string, parameters?: Record<string, unknown>) {
    // Never the token, the URL or the Bot API description.
    super(`Bot API ${method} failed (code ${code})`);
    this.name = 'BotApiError';
    this.code = code;
    this.description = '';
    this.method = method;
    if (parameters !== undefined) this.parameters = parameters;
  }
}
