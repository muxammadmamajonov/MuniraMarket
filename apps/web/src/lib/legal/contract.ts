import type { Locale } from '@muniramarket/contracts';

/**
 * The contract for the storefront's legal pages: which pages exist, which sections each one must
 * have, and which metadata every page must carry. It contains NO legal text. The wording is
 * written and approved by the shop's legal owner and supplied later as content that must pass
 * `validateLegalContent`; until it does, `LEGAL_CONTENT_STATUS` stays `'pending'` and no public
 * route shows any of it.
 *
 * The section lists below are a structural proposal (what a customer expects to find on such a
 * page). They are labels only, and the legal owner may add or rename sections here before the
 * content is written; the validator then enforces whatever this file says.
 */

/** A string in every supported language. */
export type Localized = Readonly<Record<Locale, string>>;

export const LEGAL_PAGE_SLUGS = ['privacy', 'offer', 'delivery', 'returns', 'contacts'] as const;
export type LegalSlug = (typeof LEGAL_PAGE_SLUGS)[number];

/**
 * Who approved a page, as a role. A person's name never goes into the content: people change, the
 * accountability stays with the role.
 */
export const LEGAL_APPROVER_ROLES = ['owner', 'director', 'legal_counsel'] as const;
export type LegalApproverRole = (typeof LEGAL_APPROVER_ROLES)[number];

export interface LegalSectionSpec {
  /** Stable identifier (an anchor and the key in the content). `camelCase`, never translated. */
  readonly id: string;
  /** The heading shown above the section, in both languages. */
  readonly title: Localized;
}

export interface LegalPageSpec {
  readonly slug: LegalSlug;
  readonly title: Localized;
  /** Every one of these must be present in the content, in both languages. */
  readonly sections: readonly LegalSectionSpec[];
}

/** Metadata every legal page must carry next to its sections. */
export interface LegalMetadata {
  /** `MAJOR.MINOR` (or `MAJOR.MINOR.PATCH`): bumped whenever the wording changes. */
  readonly version: string;
  /** `YYYY-MM-DD`: the day this wording takes effect. */
  readonly effectiveDate: string;
  readonly approvedBy: LegalApproverRole;
}

/** The text of one section in both languages (plain text or Markdown, decided at render time). */
export type LegalSectionContent = Localized;

/** What the legal owner supplies for one page. */
export interface LegalPageContent extends LegalMetadata {
  readonly slug: LegalSlug;
  /** One entry per required section id of the page's spec. */
  readonly sections: Readonly<Record<string, LegalSectionContent>>;
}

/** `‘` (U+2018) and `’` (U+2019) are the apostrophes the dictionaries use for Uzbek. */
export const LEGAL_PAGES: Readonly<Record<LegalSlug, LegalPageSpec>> = {
  privacy: {
    slug: 'privacy',
    title: { uz: 'Maxfiylik siyosati', ru: 'Политика конфиденциальности' },
    sections: [
      { id: 'operator', title: { uz: 'Operator haqida', ru: 'Об операторе' } },
      {
        id: 'dataCollected',
        title: { uz: 'Qanday ma’lumotlar yig‘iladi', ru: 'Какие данные собираются' },
      },
      {
        id: 'purposes',
        title: {
          uz: 'Ma’lumotlardan foydalanish maqsadlari',
          ru: 'Цели использования данных',
        },
      },
      {
        id: 'sharing',
        title: {
          uz: 'Ma’lumotlarni uchinchi shaxslarga berish',
          ru: 'Передача данных третьим лицам',
        },
      },
      { id: 'retention', title: { uz: 'Saqlash muddati', ru: 'Сроки хранения' } },
      { id: 'rights', title: { uz: 'Foydalanuvchi huquqlari', ru: 'Права пользователя' } },
      { id: 'contact', title: { uz: 'Murojaat uchun aloqa', ru: 'Контакты для обращений' } },
    ],
  },
  offer: {
    slug: 'offer',
    title: { uz: 'Ommaviy oferta', ru: 'Публичная оферта' },
    sections: [
      { id: 'parties', title: { uz: 'Taraflar va atamalar', ru: 'Стороны и термины' } },
      { id: 'subject', title: { uz: 'Shartnoma predmeti', ru: 'Предмет договора' } },
      { id: 'ordering', title: { uz: 'Buyurtma berish tartibi', ru: 'Порядок оформления заказа' } },
      { id: 'pricing', title: { uz: 'Narxlar va to‘lov', ru: 'Цены и оплата' } },
      { id: 'liability', title: { uz: 'Taraflarning javobgarligi', ru: 'Ответственность сторон' } },
      { id: 'disputes', title: { uz: 'Nizolarni hal qilish', ru: 'Разрешение споров' } },
      { id: 'sellerDetails', title: { uz: 'Sotuvchi rekvizitlari', ru: 'Реквизиты продавца' } },
    ],
  },
  delivery: {
    slug: 'delivery',
    title: { uz: 'Yetkazib berish', ru: 'Доставка' },
    sections: [
      { id: 'zones', title: { uz: 'Yetkazib berish hududlari', ru: 'Зоны доставки' } },
      { id: 'fees', title: { uz: 'Yetkazib berish narxi', ru: 'Стоимость доставки' } },
      { id: 'slots', title: { uz: 'Yetkazib berish vaqti', ru: 'Время доставки' } },
      { id: 'receiving', title: { uz: 'Buyurtmani qabul qilish', ru: 'Получение заказа' } },
      { id: 'problems', title: { uz: 'Kechikish va muammolar', ru: 'Задержки и проблемы' } },
    ],
  },
  returns: {
    slug: 'returns',
    title: { uz: 'Qaytarish va almashtirish', ru: 'Возврат и обмен' },
    sections: [
      { id: 'conditions', title: { uz: 'Qaytarish shartlari', ru: 'Условия возврата' } },
      { id: 'process', title: { uz: 'Qaytarish tartibi', ru: 'Порядок возврата' } },
      { id: 'refunds', title: { uz: 'Pulni qaytarish', ru: 'Возврат денег' } },
      {
        id: 'exceptions',
        title: { uz: 'Qaytarilmaydigan mahsulotlar', ru: 'Товары, не подлежащие возврату' },
      },
    ],
  },
  contacts: {
    slug: 'contacts',
    title: { uz: 'Aloqa', ru: 'Контакты' },
    sections: [
      { id: 'seller', title: { uz: 'Sotuvchi', ru: 'Продавец' } },
      { id: 'address', title: { uz: 'Manzil', ru: 'Адрес' } },
      { id: 'channels', title: { uz: 'Aloqa kanallari', ru: 'Каналы связи' } },
      { id: 'hours', title: { uz: 'Ish vaqti', ru: 'Часы работы' } },
    ],
  },
};

export function isLegalSlug(value: unknown): value is LegalSlug {
  return typeof value === 'string' && (LEGAL_PAGE_SLUGS as readonly string[]).includes(value);
}

export function isLegalApproverRole(value: unknown): value is LegalApproverRole {
  return typeof value === 'string' && (LEGAL_APPROVER_ROLES as readonly string[]).includes(value);
}
