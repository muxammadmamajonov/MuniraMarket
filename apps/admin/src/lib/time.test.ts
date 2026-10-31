import { describe, expect, it } from 'vitest';
import {
  addDays,
  cutoffToIso,
  defaultCutoff,
  isHHMM,
  isIsoDate,
  isoToCutoff,
  tashkentIso,
  todayInTashkent,
} from './time';

describe('Tashkent time helpers', () => {
  it('computes "today" in Tashkent, not in the browser zone', () => {
    // 20:30 UTC is already the next day in Tashkent (UTC+5).
    expect(todayInTashkent(new Date('2026-10-31T20:30:00Z'))).toBe('2026-11-01');
    expect(todayInTashkent(new Date('2026-10-31T18:59:00Z'))).toBe('2026-10-31');
  });

  it('defaults the cut-off to two hours before the start, across midnight and month ends', () => {
    expect(defaultCutoff('2026-11-02', '14:00')).toBe('2026-11-02T12:00');
    expect(defaultCutoff('2026-11-01', '01:30')).toBe('2026-10-31T23:30');
    expect(defaultCutoff('2026-03-01', '00:00')).toBe('2026-02-28T22:00');
    expect(defaultCutoff('', '14:00')).toBe('');
    expect(defaultCutoff('2026-11-02', '25:00')).toBe('');
  });

  it('writes ISO times with the +05:00 offset and reads them back', () => {
    expect(cutoffToIso('2026-11-02T12:00')).toBe('2026-11-02T12:00:00+05:00');
    expect(tashkentIso('2026-11-02', '14:00')).toBe('2026-11-02T14:00:00+05:00');
    expect(isoToCutoff('2026-11-02T07:00:00Z')).toBe('2026-11-02T12:00');
    expect(isoToCutoff('2026-11-02T12:00:00+05:00')).toBe('2026-11-02T12:00');
    expect(isoToCutoff('nope')).toBe('');
  });

  it('validates and shifts dates', () => {
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('26-02-28')).toBe(false);
    expect(addDays('2026-10-31', 13)).toBe('2026-11-13');
    expect(isHHMM('09:05')).toBe(true);
    expect(isHHMM('9:05')).toBe(false);
    expect(isHHMM('24:00')).toBe(false);
  });
});
