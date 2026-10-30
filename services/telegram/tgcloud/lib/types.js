// @ts-check
/**
 * Shared JSDoc typedefs. This module has no runtime behaviour; it exists so other modules can
 * reference the types with `import('../types.js').Name`.
 */

/**
 * @typedef {'uz' | 'ru'} Locale
 */

/**
 * @typedef {'NEW' | 'CONFIRMED' | 'PICKING' | 'READY_FOR_DELIVERY' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'CANCELLED'} OrderStatus
 */

/**
 * Telegram user as delivered in `message.from` or `ctx.initData.user`.
 * @typedef {object} TelegramUser
 * @property {number} id
 * @property {string} first_name
 * @property {string} [last_name]
 * @property {string} [username]
 * @property {string} [language_code]
 * @property {boolean} [is_bot]
 */

/**
 * @typedef {object} Logger
 * @property {(...args: unknown[]) => void} log
 * @property {(...args: unknown[]) => void} warn
 * @property {(...args: unknown[]) => void} error
 */

/**
 * @typedef {object} ServiceConfig
 * @property {string} baseUrl Normalised origin of the Core API, no trailing slash and no path.
 * @property {string} keyId
 * @property {string} secret
 */

/**
 * @typedef {object} CoreApiClient
 * @property {(method: string, path: string, options?: {actorTelegramUserId?: number, json?: unknown}) => Promise<unknown>} request
 * @property {(user: TelegramUser) => Promise<unknown>} syncTelegramUser
 * @property {(telegramUserId: number) => Promise<unknown>} getMe
 */

export {};
