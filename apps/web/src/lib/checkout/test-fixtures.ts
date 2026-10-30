import type {
  Cart,
  CartLine,
  CheckoutQuote,
  DeliveryZone,
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
  street: textOfLength('Ulug‘bekMirzoUlug‘bekTumaniSohilBo‘yiKo‘chasi', 200),
  landmark: textOfLength('YunusobodTumaniMetroStansiyasiYonidagiKattaDo‘kon', 200),
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

export function zone(overrides: Partial<DeliveryZone> = {}): DeliveryZone {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'demo-markaziy',
    name_uz: 'Demo markaziy zona',
    name_ru: 'Демо центральная зона',
    delivery_fee_uzs: 15000,
    free_delivery_threshold_uzs: 300000,
    min_order_uzs: 50000,
    opens_at: '09:00',
    closes_at: '21:00',
    is_open_now: true,
    districts: [
      { code: 'yunusobod', name_uz: 'Yunusobod', name_ru: 'Юнусабад' },
      { code: 'mirobod', name_uz: 'Mirobod', name_ru: 'Миробад' },
    ],
    ...overrides,
  };
}

export function farZone(): DeliveryZone {
  return zone({
    id: '22222222-2222-4222-8222-222222222222',
    slug: 'demo-chekka',
    name_uz: 'Demo chekka zona',
    name_ru: 'Демо окраинная зона',
    delivery_fee_uzs: 0,
    free_delivery_threshold_uzs: null,
    min_order_uzs: 100000,
    districts: [{ code: 'chilonzor', name_uz: 'Chilonzor', name_ru: 'Чиланзар' }],
  });
}

export function quote(overrides: Partial<CheckoutQuote> = {}): CheckoutQuote {
  return {
    items: [line()],
    item_count: 4,
    subtotal_uzs: 60000,
    delivery_fee_uzs: 15000,
    total_uzs: 75000,
    free_delivery_remaining_uzs: 240000,
    zone: zone(),
    issues: [],
    can_place_order: true,
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
    delivery_fee_uzs: 15000,
    total_uzs: 75000,
    item_count: 4,
    payment_method: 'cash_on_delivery',
    recipient_name: 'Ali Valiyev',
    recipient_phone: '+998001234567',
    address: {
      district: 'yunusobod',
      district_name_uz: 'Yunusobod',
      district_name_ru: 'Юнусабад',
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
