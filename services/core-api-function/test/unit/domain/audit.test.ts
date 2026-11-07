import { describe, expect, it } from 'vitest';
import {
  AuditInstant,
  diffFields,
  MAX_TEXT_LENGTH,
  safeDetails,
  sameValue,
} from '../../../src/audit.ts';

describe('safeDetails', () => {
  it('keeps only allow-listed fields', () => {
    expect(
      safeDetails('product', {
        price_uzs: [10_000, 12_000],
        stock_quantity: [null, 5],
        is_active: [true, false],
        description_uz: ['old', 'new'],
        brand: ['a', 'b'],
      }),
    ).toEqual({
      changes: {
        price_uzs: { from: 10_000, to: 12_000 },
        stock_quantity: { from: null, to: 5 },
        is_active: { from: true, to: false },
      },
    });
  });

  const personal = [
    'phone',
    'recipient_phone',
    'address',
    'first_name',
    'last_name',
    'username',
    'telegram_user_id',
    'init_data',
    'csrf_token',
    'session_cookie',
    'comment',
    'cancel_reason',
    'password',
  ];
  for (const entityType of ['user', 'order', 'product', 'unknown']) {
    it.each(personal)(`never lets %s through (${entityType})`, (field) => {
      expect(
        safeDetails(
          entityType,
          { [field]: ['+998901234567', 'Demo Person'] },
          { [field]: 'secret-value' },
        ),
      ).toEqual({});
    });
  }

  it('user changes are role and block only', () => {
    expect(
      safeDetails(
        'user',
        { role: ['customer', 'admin'], is_blocked: [false, true] },
        { username: 'demo_user' },
      ),
    ).toEqual({
      changes: { role: { from: 'customer', to: 'admin' }, is_blocked: { from: false, to: true } },
    });
  });

  it('extra keys are allow-listed; has_reason only as a boolean', () => {
    expect(
      safeDetails('catalog', null, {
        source: 'csv',
        rows: 3,
        creates: 1,
        file_name: 'x.csv',
        note: 'y',
      }),
    ).toEqual({ source: 'csv', rows: 3, creates: 1 });
    expect(safeDetails('order', null, { has_reason: true })).toEqual({ has_reason: true });
    expect(safeDetails('order', null, { has_reason: 'text of the reason' })).toEqual({});
  });

  it('values become short scalars', () => {
    const details = safeDetails('product', {
      category_id: [null, '0b8f6a52-7c1e-4e0e-9d0e-5c8d2f1b7a10'],
      name_uz: ['a', 'x'.repeat(500)],
      price_uzs: [null, 1.5],
    }) as { changes: Record<string, { from: unknown; to: unknown }> };
    expect(details.changes['category_id']).toEqual({
      from: null,
      to: '0b8f6a52-7c1e-4e0e-9d0e-5c8d2f1b7a10',
    });
    const truncated = details.changes['name_uz']?.to as string;
    expect([...truncated]).toHaveLength(MAX_TEXT_LENGTH);
    expect(truncated.endsWith('…')).toBe(true);
    expect(details.changes['price_uzs']?.to).toBeNull();
  });

  it('dates, times, instants and lists', () => {
    const details = safeDetails('slot', {
      slot_date: [null, '2026-11-01'],
      starts_at: [null, '09:00:00'],
      cutoff_at: [null, new AuditInstant(0n, '2026-11-01T06:00:00+00:00')],
    }) as { changes: Record<string, { to: unknown }> };
    expect(details.changes['slot_date']?.to).toBe('2026-11-01');
    expect(details.changes['starts_at']?.to).toBe('09:00:00');
    expect(details.changes['cutoff_at']?.to).toBe('2026-11-01T06:00:00+00:00');
    expect(safeDetails('zone', { districts: [['b', 'a'], ['c']] })).toEqual({
      changes: { districts: { from: 'a,b', to: 'c' } },
    });
  });
});

describe('diffFields', () => {
  it('returns only changed pairs', () => {
    expect(diffFields({ a: 1, b: 2 }, { a: 1, b: 3, c: null })).toEqual({ b: [2, 3] });
  });

  it('compares instants by instant, not by text', () => {
    const utc = new AuditInstant(1_000_000n, '1970-01-01T00:00:01+00:00');
    const local = new AuditInstant(1_000_000n, '1970-01-01T05:00:01+05:00');
    expect(sameValue(utc, local)).toBe(true);
    expect(diffFields({ cutoff_at: utc }, { cutoff_at: local })).toEqual({});
    const later = new AuditInstant(2_000_000n, '1970-01-01T05:00:02+05:00');
    expect(diffFields({ cutoff_at: utc }, { cutoff_at: later })).toEqual({
      cutoff_at: [utc, later],
    });
  });
});
