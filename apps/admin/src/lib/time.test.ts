import { describe, expect, it } from 'vitest';
import { todayInTashkent } from './time';

describe('Tashkent time helpers', () => {
  it('computes "today" in Tashkent, not in the browser zone', () => {
    // 20:30 UTC is already the next day in Tashkent (UTC+5).
    expect(todayInTashkent(new Date('2026-10-31T20:30:00Z'))).toBe('2026-11-01');
    expect(todayInTashkent(new Date('2026-10-31T18:59:00Z'))).toBe('2026-10-31');
  });
});
