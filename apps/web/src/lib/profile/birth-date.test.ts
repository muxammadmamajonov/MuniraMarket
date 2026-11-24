import { describe, expect, it } from 'vitest';
import { isoToDisplay, maskBirthDateInput, parseBirthDate, tashkentToday } from './birth-date';

describe('birth date mask', () => {
  it('inserts the dots as the customer types', () => {
    expect(maskBirthDateInput('0')).toBe('0');
    expect(maskBirthDateInput('09')).toBe('09');
    expect(maskBirthDateInput('090')).toBe('09.0');
    expect(maskBirthDateInput('0903')).toBe('09.03');
    expect(maskBirthDateInput('09032001')).toBe('09.03.2001');
    expect(maskBirthDateInput('0903200155')).toBe('09.03.2001');
  });

  it('does not trap backspace on a dot', () => {
    // Deleting the "0" of "09.0" leaves "09." in the field; the mask turns it back into "09".
    expect(maskBirthDateInput('09.')).toBe('09');
  });

  it('round-trips ISO dates', () => {
    expect(isoToDisplay('2001-03-09')).toBe('09.03.2001');
    expect(isoToDisplay(null)).toBe('');
    expect(isoToDisplay('garbage')).toBe('');
  });
});

describe('parseBirthDate', () => {
  const today = '2026-11-13';

  it('treats an empty field as no birthday', () => {
    expect(parseBirthDate('', today)).toEqual({ ok: true, iso: null });
  });

  it('reads a full date', () => {
    expect(parseBirthDate('09.03.2001', today)).toEqual({ ok: true, iso: '2001-03-09' });
    expect(parseBirthDate('13.11.2026', today)).toEqual({ ok: true, iso: '2026-11-13' });
  });

  it('rejects incomplete, impossible, future and too-old dates', () => {
    expect(parseBirthDate('09.03', today)).toEqual({ ok: false, error: 'incomplete' });
    expect(parseBirthDate('31.02.2000', today)).toEqual({ ok: false, error: 'invalid' });
    expect(parseBirthDate('00.01.2000', today)).toEqual({ ok: false, error: 'invalid' });
    expect(parseBirthDate('14.11.2026', today)).toEqual({ ok: false, error: 'future' });
    expect(parseBirthDate('31.12.1899', today)).toEqual({ ok: false, error: 'tooOld' });
    expect(parseBirthDate('29.02.2024', today)).toEqual({ ok: true, iso: '2024-02-29' });
  });

  it('uses the Tashkent calendar day', () => {
    // 20:30 UTC on the 12th is already the 13th in Tashkent (UTC+5).
    expect(tashkentToday(new Date('2026-11-12T20:30:00Z'))).toBe('2026-11-13');
  });
});
