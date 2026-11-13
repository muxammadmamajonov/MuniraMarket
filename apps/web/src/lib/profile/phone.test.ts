import { describe, expect, it } from 'vitest';
import { formatUzPhone, maskUzPhoneInput, nationalDigits, toE164, validateUzPhone } from './phone';

describe('Uzbekistan phone mask', () => {
  it('groups the national digits after the fixed prefix', () => {
    expect(formatUzPhone('')).toBe('+998');
    expect(formatUzPhone('9')).toBe('+998 9');
    expect(formatUzPhone('901')).toBe('+998 90 1');
    expect(formatUzPhone('901234567')).toBe('+998 90 123 45 67');
  });

  it('masks only the national part (the prefix sits beside the field)', () => {
    expect(maskUzPhoneInput('')).toBe('');
    expect(maskUzPhoneInput('90')).toBe('90');
    expect(maskUzPhoneInput('90123')).toBe('90 123');
    expect(maskUzPhoneInput('90 123 45 678')).toBe('90 123 45 67');
    expect(maskUzPhoneInput('90-123')).toBe('90 123');
  });

  it('accepts pasted numbers in any common shape', () => {
    expect(nationalDigits('+998 (90) 123-45-67')).toBe('901234567');
    expect(nationalDigits('998901234567')).toBe('901234567');
    expect(nationalDigits('90 123 45 67')).toBe('901234567');
    expect(maskUzPhoneInput('+998901234567')).toBe('90 123 45 67');
  });

  it('validates length and the leading digit', () => {
    expect(validateUzPhone('')).toBe('required');
    expect(validateUzPhone('90123')).toBe('incomplete');
    expect(validateUzPhone('012345678')).toBe('invalid');
    expect(validateUzPhone('901234567')).toBeNull();
    expect(validateUzPhone('712345678')).toBeNull();
  });

  it('builds the API value', () => {
    expect(toE164('901234567')).toBe('+998901234567');
  });
});
