import { describe, expect, it } from 'vitest';
import {
  ORDER_STATUSES,
  PAYMENT_METHODS,
  PRODUCT_UNITS,
  USER_ROLES,
  isOrderStatus,
  isPaymentMethod,
  isProductUnit,
  isUserRole,
} from './enums';

describe('enums', () => {
  it('lists order statuses in lifecycle order', () => {
    expect(ORDER_STATUSES).toEqual([
      'NEW',
      'CONFIRMED',
      'PICKING',
      'READY_FOR_DELIVERY',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
      'CANCELLED',
    ]);
  });

  it('lists roles, payment methods and units', () => {
    expect(USER_ROLES).toEqual(['customer', 'operator', 'admin']);
    expect(PAYMENT_METHODS).toEqual(['cash_on_delivery', 'card_on_delivery']);
    expect(PRODUCT_UNITS).toEqual(['piece', 'kg', 'g', 'l', 'ml']);
  });

  it('type guards accept every member and reject everything else', () => {
    for (const s of ORDER_STATUSES) expect(isOrderStatus(s)).toBe(true);
    for (const r of USER_ROLES) expect(isUserRole(r)).toBe(true);
    for (const p of PAYMENT_METHODS) expect(isPaymentMethod(p)).toBe(true);
    for (const u of PRODUCT_UNITS) expect(isProductUnit(u)).toBe(true);

    expect(isOrderStatus('new')).toBe(false);
    expect(isOrderStatus(undefined)).toBe(false);
    expect(isUserRole('root')).toBe(false);
    expect(isUserRole(0)).toBe(false);
    expect(isPaymentMethod('crypto')).toBe(false);
    expect(isProductUnit('oz')).toBe(false);
    expect(isProductUnit(null)).toBe(false);
  });
});
