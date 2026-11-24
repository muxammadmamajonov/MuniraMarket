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
 * @property {(name: string) => string} personalGreeting
 * @property {string} openShop
 * @property {string} languageSaved
 * @property {string} phoneRequest
 * @property {string} phoneButton
 * @property {string} phoneVerified
 * @property {string} phoneNotOwn
 * @property {string} genericError
 * @property {string} orderLabel
 * @property {string} totalLabel
 * @property {string} cancelReasonLabel
 * @property {string} currency
 * @property {Record<import('./types.js').OrderStatus, string>} orderStatus
 * @property {string} orderAdjusted headline of the "your order changed" message (ADR 0018)
 * @property {string} adjustedIntro
 * @property {string} newTotalLabel
 * @property {string} adjustedCancelHint
 * @property {Record<import('./types.js').Unit, string>} units
 */

/** @type {Record<import('./types.js').Locale, Messages>} */
export const MESSAGES = {
  uz: {
    startGreeting:
      'MuniraMarket’ga xush kelibsiz! Mahsulotlarni tanlash va buyurtma berish uchun do‘konni oching.',
    personalGreeting: (name) =>
      `Assalomu alaykum, ${name}! MuniraMarket’ga xush kelibsiz. Mahsulotlarni tanlash va buyurtma berish uchun do‘konni oching.`,
    openShop: 'Do‘konni ochish',
    languageSaved:
      'Til saqlandi: o‘zbekcha. Uni istalgan vaqt do‘kondagi Profil bo‘limida o‘zgartirishingiz mumkin.',
    phoneRequest:
      'Buyurtmani tasdiqlash uchun telefon raqamingiz kerak. Pastdagi tugmani bosing — Telegram faqat sizning roziligingiz bilan raqamingizni yuboradi.',
    phoneButton: 'Raqamimni yuborish',
    phoneVerified: 'Rahmat! Raqamingiz tasdiqlandi. Endi buyurtma berishingiz mumkin.',
    phoneNotOwn: 'Iltimos, o‘z raqamingizni pastdagi tugma orqali yuboring.',
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
    orderAdjusted: 'Buyurtmangiz o‘zgardi',
    adjustedIntro: 'Afsuski, ba’zi mahsulotlar yetarli emas ekan:',
    newTotalLabel: 'Yangi jami',
    adjustedCancelHint: 'Buyurtma endi kerak bo‘lmasa, uni ilovada bekor qilishingiz mumkin.',
    units: { piece: 'dona', kg: 'kg', g: 'g', l: 'l', ml: 'ml' },
  },
  ru: {
    startGreeting:
      'Добро пожаловать в MuniraMarket! Откройте магазин, чтобы выбрать товары и оформить заказ.',
    personalGreeting: (name) =>
      `Здравствуйте, ${name}! Добро пожаловать в MuniraMarket. Откройте магазин, чтобы выбрать товары и оформить заказ.`,
    openShop: 'Открыть магазин',
    languageSaved:
      'Язык сохранён: русский. Его можно изменить в любой момент в разделе «Профиль» в магазине.',
    phoneRequest:
      'Чтобы подтвердить заказ, нужен ваш номер телефона. Нажмите кнопку ниже — Telegram отправит номер только с вашего согласия.',
    phoneButton: 'Отправить мой номер',
    phoneVerified: 'Спасибо! Номер подтверждён. Теперь можно оформить заказ.',
    phoneNotOwn: 'Пожалуйста, отправьте свой номер кнопкой ниже.',
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
    orderAdjusted: 'Ваш заказ изменён',
    adjustedIntro: 'К сожалению, некоторых товаров оказалось недостаточно:',
    newTotalLabel: 'Новая сумма',
    adjustedCancelHint: 'Если заказ больше не нужен, его можно отменить в приложении.',
    units: { piece: 'шт', kg: 'кг', g: 'г', l: 'л', ml: 'мл' },
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

/**
 * Staff-facing texts. `/connect_orders` replies carry both languages (Uzbek first, then Russian,
 * separated by a blank line). Order alerts in the staff group are Uzbek only (owner's request);
 * they are sent as Telegram HTML, so every value is escaped by the builder.
 */
export const STAFF_MESSAGES = Object.freeze({
  connectOrders: Object.freeze({
    connected:
      'Guruh ulandi: yangi buyurtmalar va muhim holat o‘zgarishlari shu guruhga yuboriladi.\n\n' +
      'Группа подключена: новые заказы и важные изменения статуса будут приходить в эту группу.',
    forbidden:
      'Guruhni faqat MuniraMarket administratori ulay oladi.\n\n' +
      'Подключить группу может только администратор MuniraMarket.',
    failed:
      'Hozir guruhni ulab bo‘lmadi. Iltimos, keyinroq qayta urinib ko‘ring.\n\n' +
      'Сейчас не удалось подключить группу. Пожалуйста, попробуйте позже.',
    groupOnly:
      'Bu buyruq faqat xodimlar guruhida ishlaydi: botni guruhga qo‘shing va buyruqni o‘sha yerda yuboring.\n\n' +
      'Эта команда работает только в группе сотрудников: добавьте бота в группу и отправьте команду там.',
    anonymous:
      'Buyruqni shaxsiy hisobingizdan yuboring: guruhdagi administrator sozlamalarida “Anonim qolish”ni o‘chiring.\n\n' +
      'Отправьте команду от своего личного аккаунта: отключите «Оставаться анонимным» в настройках администратора группы.',
  }),
  staffAlert: Object.freeze({
    headline: Object.freeze({
      NEW: 'Yangi buyurtma',
      CANCELLED: 'Buyurtma bekor qilindi',
      OUT_FOR_DELIVERY: 'Buyurtma yetkazishga chiqdi',
      DELIVERED: 'Buyurtma yetkazildi',
      other: 'Buyurtma holati o‘zgardi',
    }),
    statusLabel: 'Holat',
    totalLabel: 'Jami',
    subtotalLabel: 'Mahsulotlar summasi',
    currency: 'so‘m',
    cancelledByCustomer: 'Mijoz tomonidan bekor qilindi',
    createdLabel: 'Vaqti',
    itemsLabel: 'Mahsulotlar',
    /** @param {number} count */
    moreItems: (count) => `+${count} ta mahsulot`,
    paymentLabel: 'To‘lov',
    payment: Object.freeze({
      cash_on_delivery: 'Naqd pul, qabul qilganda',
      card_on_delivery: 'Karta orqali, qabul qilganda',
    }),
    recipientLabel: 'Qabul qiluvchi',
    phoneLabel: 'Telefon',
    addressLabel: 'Manzil',
    /** Address part suffixes: `15-uy, 12-xonadon, 2-podyezd, 3-qavat`. */
    addressParts: Object.freeze({
      house: 'uy',
      apartment: 'xonadon',
      entrance: 'podyezd',
      floor: 'qavat',
    }),
    landmarkLabel: 'Mo‘ljal',
    commentLabel: 'Izoh',
    units: Object.freeze({ piece: 'dona', kg: 'kg', g: 'g', l: 'l', ml: 'ml' }),
    status: Object.freeze({
      NEW: 'Yangi',
      CONFIRMED: 'Tasdiqlangan',
      PICKING: 'Yig‘ilmoqda',
      READY_FOR_DELIVERY: 'Yetkazishga tayyor',
      OUT_FOR_DELIVERY: 'Yo‘lda',
      DELIVERED: 'Yetkazildi',
      CANCELLED: 'Bekor qilingan',
    }),
    /** Order lines lowered at picking (ADR 0018). */
    adjustedHeadline: 'Buyurtma o‘zgartirildi',
    outOfStock: 'omborda qolmadi',
    reasonLabel: 'Sabab',
    newTotalLabel: 'Yangi jami',
    /** Inline button under a NEW order alert: opens Yandex Go with the order's destination. */
    courierButton: 'Yandex chaqirish',
    /** Inline button under every alert: opens the order in the admin. */
    adminButton: 'Adminda ochish',
  }),
});

/**
 * First-start language prompt. Shown before any language is known, so it is bilingual; the
 * buttons are each language's own name.
 * @param {string} name
 */
export function languagePrompt(name) {
  return (
    `Assalomu alaykum, ${name}! Qaysi tilda davom etamiz?\n\n` +
    `Здравствуйте, ${name}! На каком языке продолжим?`
  );
}

export const LANGUAGE_BUTTONS = Object.freeze({ uz: 'O‘zbekcha', ru: 'Русский' });
