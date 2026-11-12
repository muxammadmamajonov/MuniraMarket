import type {
  AdminCategory,
  AdminProduct,
  AdminUser,
  AuditEntry,
  Dashboard,
} from '@muniramarket/contracts';

/** Synthetic back-office data: no real names, phones or addresses. */

export const IDS = {
  category: '2a1d5c3e-0000-4000-8000-000000000001',
  subcategory: '2a1d5c3e-0000-4000-8000-000000000002',
  product: '3b2e6d4f-0000-4000-8000-000000000001',
  user: '4c3f7e50-0000-4000-8000-000000000001',
} as const;

const STAMP = '2026-10-31T09:05:00Z';

export function dashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    date: '2026-10-31',
    timezone: 'Asia/Tashkent',
    orders_today: 42,
    new_orders: 7,
    gmv_today_uzs: 5_250_000,
    average_order_value_uzs: 131_250,
    cancelled_today: 3,
    ...overrides,
  };
}

export function category(overrides: Partial<AdminCategory> = {}): AdminCategory {
  return {
    id: IDS.category,
    slug: 'fruits',
    name_uz: 'Mevalar',
    name_ru: 'Фрукты',
    parent_id: null,
    sort_order: 0,
    is_active: true,
    image_url: null,
    product_count: 2,
    child_count: 1,
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  };
}

export function subcategory(overrides: Partial<AdminCategory> = {}): AdminCategory {
  return category({
    id: IDS.subcategory,
    slug: 'apples',
    name_uz: 'Olmalar',
    name_ru: 'Яблоки',
    parent_id: IDS.category,
    product_count: 1,
    child_count: 0,
    ...overrides,
  });
}

export function product(overrides: Partial<AdminProduct> = {}): AdminProduct {
  return {
    id: IDS.product,
    sku: 'TEST-APPLE',
    slug: 'test-apple',
    name_uz: 'Test olma',
    name_ru: 'Тестовое яблоко',
    description_uz: null,
    description_ru: null,
    category_id: IDS.subcategory,
    unit: 'kg',
    price_uzs: 30_000,
    old_price_uzs: null,
    stock_quantity: 25,
    is_active: true,
    sort_order: 0,
    image_url: null,
    archived_at: null,
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  };
}

export function adminUser(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: IDS.user,
    telegram_user_id: 555001,
    first_name: 'Test',
    last_name: 'Admin',
    username: 'test_admin',
    language: 'uz',
    role: 'admin',
    is_blocked: false,
    created_at: STAMP,
    ...overrides,
  };
}

export function auditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: '7f62a183-0000-4000-8000-000000000001',
    created_at: STAMP,
    actor_user_id: IDS.user,
    actor_role: 'admin',
    action: 'product.update',
    entity_type: 'product',
    entity_id: IDS.product,
    details: { changes: { price_uzs: { from: 25_000, to: 30_000 } } },
    ...overrides,
  };
}

export const page = <T>(items: T[], extra: Record<string, unknown> = {}) => ({
  items,
  page: 1,
  page_size: 20,
  total: items.length,
  total_pages: items.length === 0 ? 0 : 1,
  ...extra,
});
