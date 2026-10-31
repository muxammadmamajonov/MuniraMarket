import type {
  AdminCategory,
  AdminProduct,
  AdminUser,
  DeliverySlotAdmin,
  DeliveryZoneAdmin,
} from '@muniramarket/contracts';
import { DISTRICT_CODES } from '@/lib/districts';
import { IDS, auditEntry, category, product, slot, subcategory, zone, adminUser } from './fixtures';

/**
 * Worst realistic data for the back-office screens (break-ui): every value is a real naming
 * pattern or the API's own limit (255-char names, 64-char SKUs, 10 000 capacity, 1e12 prices).
 * Kept as the regression fixture for the next change to these screens.
 */
export const LONG_NAME =
  'Bartholomew-Fitzgerald-Northwind-Industries-Holdings Extra-Virgin Organic Cold-Pressed Sunflower Oil 5L Family Pack (Limited Edition)';
export const LONG_SKU = 'NORTHWIND-ORGANIC-SUNFLOWER-OIL-5L-FAMILY-PACK-LIMITED-2026-X'.slice(
  0,
  64,
);

export const worstProducts: AdminProduct[] = [
  product({
    sku: LONG_SKU,
    name_uz: LONG_NAME,
    name_ru: LONG_NAME,
    price_uzs: 999_999_999_999,
    old_price_uzs: 1_000_000_000_000,
    stock_quantity: 1_000_000,
  }),
  product({
    id: 'p2',
    sku: 'X',
    name_uz: 'Q',
    name_ru: 'Я',
    price_uzs: 0,
    stock_quantity: 0,
    is_active: false,
  }),
  product({
    id: 'p3',
    sku: 'EMO-1',
    name_uz: '🦊 Tulki 👩🏽‍💻',
    name_ru: 'Ёж',
    stock_quantity: null,
    archived_at: '2026-10-31T09:05:00Z',
    is_active: false,
  }),
];

export const worstCategories: AdminCategory[] = [
  category({ name_uz: 'Q', name_ru: 'Я', product_count: 1, child_count: 1 }),
  subcategory({
    name_uz: 'Mavsumiy organik meva va sabzavotlar, vazn va dona bo‘yicha sotiladi',
    name_ru: 'Сезонные органические фрукты и овощи, продаются на вес и поштучно',
    slug: 'organic-fruits-and-vegetables-sold-by-weight-and-by-piece-in-season-only',
    product_count: 1284,
    child_count: 0,
    is_active: false,
  }),
];

export const worstUsers: AdminUser[] = [
  adminUser({
    first_name: 'Aleksandra',
    last_name: 'Wiśniewska-Kowalczyk',
    username: 'aleksandra_wisniewska_kowalczyk_the_third_official',
    telegram_user_id: 123456789012,
  }),
  adminUser({
    id: 'u2',
    first_name: 'J',
    last_name: null,
    username: null,
    telegram_user_id: 9,
    role: 'customer',
    is_blocked: true,
  }),
  adminUser({
    id: 'u3',
    first_name: '',
    last_name: null,
    username: null,
    telegram_user_id: 77,
    role: 'operator',
  }),
  adminUser({
    id: 'u4',
    first_name: '🦊',
    last_name: '👩🏽‍💻 Priya',
    username: 'x',
    telegram_user_id: 78,
  }),
];

export const worstZone: DeliveryZoneAdmin = zone({
  name_uz: 'Toshkent shahri markaziy va chekka tumanlari, shu jumladan Yangihayot',
  name_ru: 'Центральные и окраинные районы города Ташкента, включая Янгихаётский',
  delivery_fee_uzs: 999_999_999_999,
  free_delivery_threshold_uzs: null,
  min_order_uzs: 0,
  opens_at: '00:00',
  closes_at: '23:59',
  is_active: false,
  districts: DISTRICT_CODES.map((code) => ({ code, name_uz: code, name_ru: code })),
});

export const worstSlots: DeliverySlotAdmin[] = [
  slot({
    starts_at: '00:00',
    ends_at: '23:59',
    capacity: 10_000,
    reserved_count: 9_999,
    remaining: 1,
  }),
  slot({ id: 's2', capacity: 0, reserved_count: 0, remaining: 0, is_active: false }),
  slot({ id: 's3', slot_date: '2026-11-03', capacity: 1, reserved_count: 1, remaining: 0 }),
];

export const worstAudit = auditEntry({
  details: {
    changes: {
      name_uz: { from: LONG_NAME, to: `${LONG_NAME}!` },
      image_url: {
        from: null,
        to: `https://cdn.example.com/${'very/long/path/'.repeat(8)}photo.png?token=abc`,
      },
      is_active: { from: true, to: false },
    },
  },
});

export { IDS };
