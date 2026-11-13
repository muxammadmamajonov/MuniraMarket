import type { Address } from '@/lib/address/address';
import type {
  Cart,
  CartLine,
  CheckoutQuote,
  OrderDetail,
  OrderSummary,
  ProductSummary,
} from '@muniramarket/contracts';

/**
 * Test-only builders (not imported by app code). Demo data is deliberately kind; the `WORST`
 * values are the realistic worst cases (the longest values the API accepts, Cyrillic text, no
 * break opportunities, huge totals) used to stress the layout-relevant markup.
 */

/** Cycles `seed` up to exactly `length` characters. */
export function textOfLength(seed: string, length: number): string {
  return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
}

export const WORST = {
  /** `name_uz` / `name_ru` columns allow 255 characters. */
  productNameUz: textOfLength('Qaymoqli shokoladli glazurlangan ho‘l mevali tort ', 255).trim(),
  productNameRu: textOfLength('Вафельный торт с кремом и шоколадной глазурью ', 255).trim(),
  /** 200 characters without a single space or hyphen: no break opportunity for the browser. */
  street: textOfLength('Ulug‘bekMirzoUlug‘bekShahristoniSohilBo‘yiKo‘chasi', 200),
  landmark: textOfLength('YunusobodMetroStansiyasiYonidagiKattaDo‘kon', 200),
  /** 100 characters of Cyrillic with spaces and a hyphen, the recipient limit. */
  recipientName: textOfLength('Александра Вишневская-Ковальчик ', 100).trim(),
  comment: textOfLength('Iltimos, eshik oldiga qoldiring, qo‘ng‘iroq qilmang. ', 500).trim(),
  cancelReason: textOfLength('Boshqa joydan sotib oldim, kechirasiz. ', 300).trim(),
  /** 9 999 999 000 UZS: a realistic bulk order, 10 digits. */
  hugeTotal: 9_999_999_000,
} as const;

export function product(overrides: Partial<ProductSummary> = {}): ProductSummary {
  return {
    id: 'p1',
    slug: 'demo-apple',
    sku: 'DEMO-0001',
    name_uz: 'Demo olma',
    name_ru: 'Демо яблоко',
    unit: 'kg',
    price_uzs: 15000,
    old_price_uzs: null,
    stock_quantity: null,
    in_stock: true,
    low_stock: false,
    image_url: null,
    category_id: 'c1',
    ...overrides,
  };
}

export function line(overrides: Partial<CartLine> & { product?: ProductSummary } = {}): CartLine {
  return { product: product(), quantity: 4, line_total_uzs: 60000, issue: null, ...overrides };
}

export function cart(overrides: Partial<Cart> = {}): Cart {
  return {
    items: [line()],
    item_count: 4,
    subtotal_uzs: 60000,
    total_uzs: 60000,
    has_issues: false,
    ...overrides,
  };
}

export function quote(overrides: Partial<CheckoutQuote> = {}): CheckoutQuote {
  return {
    items: [line()],
    item_count: 4,
    subtotal_uzs: 60000,
    total_uzs: 60000,
    issues: [],
    can_place_order: true,
    ...overrides,
  };
}

/** A complete delivery address as the map picker saves it (point rounded to 6 decimals). */
export function address(overrides: Partial<Address> = {}): Address {
  return {
    lat: 41.311081,
    lon: 69.240562,
    street: 'Demo ko‘cha',
    house: '12',
    apartment: '34',
    entrance: '',
    floor: '',
    landmark: '',
    ...overrides,
  };
}

export function order(overrides: Partial<OrderDetail> = {}): OrderDetail {
  return {
    id: '3f2a9c1e-5b7d-4e8a-9c3b-1a2b3c4d5e6f',
    number: 'MM-000123',
    status: 'NEW',
    created_at: '2026-10-31T21:30:00Z',
    updated_at: '2026-10-31T21:30:00Z',
    subtotal_uzs: 60000,
    total_uzs: 60000,
    item_count: 4,
    payment_method: 'cash_on_delivery',
    recipient_name: 'Ali Valiyev',
    recipient_phone: '+998001234567',
    address: {
      lat: 41.311081,
      lon: 69.240562,
      street: 'Demo ko‘cha',
      house: '12',
      apartment: '34',
      entrance: null,
      floor: null,
      landmark: null,
    },
    comment: null,
    cancel_reason: null,
    items: [
      {
        product_id: 'p1',
        sku: 'DEMO-0001',
        name_uz: 'Demo olma',
        name_ru: 'Демо яблоко',
        unit: 'kg',
        unit_price_uzs: 15000,
        quantity: 4,
        original_quantity: 4,
        adjusted: false,
        line_total_uzs: 60000,
      },
    ],
    history: [{ status: 'NEW', at: '2026-10-31T21:30:00Z' }],
    can_cancel: true,
    ...overrides,
  };
}

export function orderSummary(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: '3f2a9c1e-5b7d-4e8a-9c3b-1a2b3c4d5e6f',
    number: 'MM-000123',
    status: 'NEW',
    total_uzs: 75000,
    item_count: 4,
    created_at: '2026-10-31T21:30:00Z',
    thumbnails: [
      {
        product_id: '7c1e2d3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
        name_uz: 'Demo olma',
        name_ru: 'Демо яблоко',
        image_url: null,
      },
    ],
    ...overrides,
  };
}

/** JSON `Response` helper. */
export function respond(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, { status, headers });
}

export function apiError(
  code: string,
  status: number,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return Response.json({ error: { code, message: code, ...extra } }, { status, headers });
}
