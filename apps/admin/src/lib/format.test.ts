import { describe, expect, it } from 'vitest';
import { formatDateTime, telHref } from './format';

describe('formatDateTime', () => {
  it('shows Asia/Tashkent time (UTC+5) regardless of the runtime zone', () => {
    expect(formatDateTime('2026-10-31T09:05:00Z')).toBe('31.10.2026 14:05');
    // Crosses midnight in Tashkent.
    expect(formatDateTime('2026-12-31T19:30:00Z')).toBe('01.01.2027 00:30');
  });

  it('uses 24-hour time and returns garbage unchanged', () => {
    expect(formatDateTime('2026-01-05T07:00:00+00:00')).toBe('05.01.2026 12:00');
    expect(formatDateTime('not a date')).toBe('not a date');
  });
});

describe('telHref', () => {
  it('keeps digits and a leading plus only', () => {
    expect(telHref('+998 00 123-45-67')).toBe('tel:+998001234567');
    expect(telHref('(90) 123 45 67')).toBe('tel:901234567');
    expect(telHref('+99+8')).toBe('tel:+998');
  });

  it('returns null when nothing is dialable', () => {
    expect(telHref('')).toBeNull();
    expect(telHref('n/a')).toBeNull();
  });
});
