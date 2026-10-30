// @ts-check
/**
 * Bot message strings (uz / ru). Copy is neutral placeholder text pending product review.
 * Uzbek uses the U+2018 apostrophe form (o‘, g‘) consistently.
 */

/** @type {readonly import('./types.js').OrderStatus[]} */
export const ORDER_STATUSES = Object.freeze([
  'NEW',
  'CONFIRMED',
  'PICKING',
  'READY_FOR_DELIVERY',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
]);

/**
 * @typedef {object} Messages
 * @property {string} startGreeting
 * @property {string} openShop
 * @property {string} genericError
 * @property {string} orderLabel
 * @property {string} totalLabel
 * @property {string} cancelReasonLabel
 * @property {string} currency
 * @property {Record<import('./types.js').OrderStatus, string>} orderStatus
 */

/** @type {Record<import('./types.js').Locale, Messages>} */
export const MESSAGES = {
  uz: {
    startGreeting:
      'MuniraMarket’ga xush kelibsiz! Mahsulotlarni tanlash va buyurtma berish uchun do‘konni oching.',
    openShop: 'Do‘konni ochish',
    genericError: 'Xatolik yuz berdi. Iltimos, keyinroq qayta urinib ko‘ring.',
    orderLabel: 'Buyurtma',
    totalLabel: 'Jami',
    cancelReasonLabel: 'Sabab',
    currency: 'so‘m',
    orderStatus: {
      NEW: 'Buyurtmangiz qabul qilindi',
      CONFIRMED: 'Buyurtmangiz tasdiqlandi',
      PICKING: 'Buyurtmangiz yig‘ilmoqda',
      READY_FOR_DELIVERY: 'Buyurtmangiz yetkazib berishga tayyor',
      OUT_FOR_DELIVERY: 'Buyurtmangiz yo‘lda',
      DELIVERED: 'Buyurtmangiz yetkazib berildi',
      CANCELLED: 'Buyurtmangiz bekor qilindi',
    },
  },
  ru: {
    startGreeting:
      'Добро пожаловать в MuniraMarket! Откройте магазин, чтобы выбрать товары и оформить заказ.',
    openShop: 'Открыть магазин',
    genericError: 'Произошла ошибка. Пожалуйста, попробуйте позже.',
    orderLabel: 'Заказ',
    totalLabel: 'Итого',
    cancelReasonLabel: 'Причина',
    currency: 'сум',
    orderStatus: {
      NEW: 'Ваш заказ принят',
      CONFIRMED: 'Ваш заказ подтверждён',
      PICKING: 'Ваш заказ собирается',
      READY_FOR_DELIVERY: 'Ваш заказ готов к доставке',
      OUT_FOR_DELIVERY: 'Ваш заказ в пути',
      DELIVERED: 'Ваш заказ доставлен',
      CANCELLED: 'Ваш заказ отменён',
    },
  },
};

/**
 * Picks the bot locale from a Telegram `language_code` (IETF tag such as `ru`, `ru-RU`, `uz`).
 * Russian maps to `ru`; everything else, including missing values, to `uz`.
 *
 * @param {string | null | undefined} languageCode
 * @returns {import('./types.js').Locale}
 */
export function pickLocale(languageCode) {
  if (typeof languageCode === 'string') {
    const primary = languageCode.trim().toLowerCase().split(/[-_]/)[0];
    if (primary === 'ru') return 'ru';
  }
  return 'uz';
}

/**
 * @param {import('./types.js').Locale | string | null | undefined} locale
 * @returns {Messages}
 */
export function messagesFor(locale) {
  return MESSAGES[pickLocale(locale)];
}

/**
 * @param {unknown} status
 * @returns {status is import('./types.js').OrderStatus}
 */
export function isOrderStatus(status) {
  return (
    typeof status === 'string' && /** @type {readonly string[]} */ (ORDER_STATUSES).includes(status)
  );
}
