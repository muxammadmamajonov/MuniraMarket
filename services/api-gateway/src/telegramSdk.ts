/**
 * Stand-in for the Telegram Serverless `sdk` module, for the shared notification code the Cron
 * Trigger reuses from `services/telegram/tgcloud/lib/` (README.md, "Scheduler").
 *
 * Those modules import exactly one thing from `sdk`: `BotApiError`, to classify Bot API failures
 * with `instanceof`. Vite/Vitest alias `sdk` to this file and tsconfig maps it here, so the
 * transport recognises the errors thrown by our own Bot API adapter (`./botApi.ts`). Nothing else
 * of the Serverless SDK exists in this Worker.
 */
export class BotApiError extends Error {
  /** Bot API `error_code` (or the HTTP status when the body had none). */
  readonly code: number;
  /** Always empty here: Bot API descriptions can echo chat data, so they are never kept. */
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
