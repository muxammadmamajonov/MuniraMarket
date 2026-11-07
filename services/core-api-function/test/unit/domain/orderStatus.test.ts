import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  InvalidOrderTransitionError,
  ORDER_STATUSES,
  allowedTransitionsOf,
  canTransition,
  customerCanCancel,
  ensureTransition,
} from '../../../src/domain/orderStatus.ts';

describe('order status transitions (port of test_order_status.py)', () => {
  it('allows each forward step', () => {
    const steps = [
      ['NEW', 'CONFIRMED'],
      ['CONFIRMED', 'PICKING'],
      ['PICKING', 'READY_FOR_DELIVERY'],
      ['READY_FOR_DELIVERY', 'OUT_FOR_DELIVERY'],
      ['OUT_FOR_DELIVERY', 'DELIVERED'],
    ] as const;
    for (const [from, to] of steps) expect(canTransition(from, to)).toBe(true);
  });

  it('cancels every non-final status only with a non-blank reason', () => {
    for (const status of [
      'NEW',
      'CONFIRMED',
      'PICKING',
      'READY_FOR_DELIVERY',
      'OUT_FOR_DELIVERY',
    ] as const) {
      expect(canTransition(status, 'CANCELLED', 'Mijoz rad etdi')).toBe(true);
      expect(canTransition(status, 'CANCELLED')).toBe(false);
      expect(canTransition(status, 'CANCELLED', '   ')).toBe(false);
    }
  });

  it('gives final statuses no exits', () => {
    for (const status of ['DELIVERED', 'CANCELLED'] as const) {
      expect(ALLOWED_TRANSITIONS[status].size).toBe(0);
      for (const target of ORDER_STATUSES) expect(canTransition(status, target, 'x')).toBe(false);
    }
  });

  it('rejects skipping and going backwards', () => {
    expect(canTransition('NEW', 'PICKING')).toBe(false);
    expect(canTransition('PICKING', 'CONFIRMED')).toBe(false);
    expect(canTransition('NEW', 'NEW')).toBe(false);
  });

  it('maps every status and lists transitions in declaration order', () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...ORDER_STATUSES].sort());
    expect(allowedTransitionsOf('NEW')).toEqual(['CONFIRMED', 'CANCELLED']);
    expect(allowedTransitionsOf('DELIVERED')).toEqual([]);
  });

  it('ensureTransition raises on invalid moves', () => {
    expect(() => ensureTransition('DELIVERED', 'NEW')).toThrow(InvalidOrderTransitionError);
    expect(() => ensureTransition('NEW', 'CONFIRMED')).not.toThrow();
  });

  it('lets customers cancel only before picking', () => {
    expect(ORDER_STATUSES.filter(customerCanCancel)).toEqual(['NEW', 'CONFIRMED']);
  });
});
