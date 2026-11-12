import { describe, expect, it } from 'vitest';
import { clampDate, daysInMonth } from './date-wheel-sheet';

describe('date wheel helpers', () => {
  it('knows month lengths, leap years included', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2023, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it('keeps the day inside the month and the date inside min..max', () => {
    expect(clampDate({ year: 2023, month: 2, day: 31 }, '1900-01-01', '2026-11-13')).toBe(
      '2023-02-28',
    );
    expect(clampDate({ year: 2026, month: 12, day: 1 }, '1900-01-01', '2026-11-13')).toBe(
      '2026-11-13',
    );
    expect(clampDate({ year: 1899, month: 5, day: 5 }, '1900-01-01', '2026-11-13')).toBe(
      '1900-01-01',
    );
  });
});
