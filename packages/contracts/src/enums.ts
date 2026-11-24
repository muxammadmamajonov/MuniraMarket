export const ORDER_STATUSES = [
  'NEW',
  'CONFIRMED',
  'PICKING',
  'READY_FOR_DELIVERY',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const USER_ROLES = ['customer', 'operator', 'admin'] as const;

export type UserRole = (typeof USER_ROLES)[number];

export const PAYMENT_METHODS = ['cash_on_delivery', 'card_on_delivery'] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PRODUCT_UNITS = ['piece', 'kg', 'g', 'l', 'ml'] as const;

export type ProductUnit = (typeof PRODUCT_UNITS)[number];

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === 'string' && (PAYMENT_METHODS as readonly string[]).includes(value);
}

export function isProductUnit(value: unknown): value is ProductUnit {
  return typeof value === 'string' && (PRODUCT_UNITS as readonly string[]).includes(value);
}
