import { describe, expect, it } from 'vitest';
import { formatUZS } from './format-uzs';

const NBSP = '\u00A0';

describe('formatUZS', () => {
  it('formats uz with U+2018 and no-break spaces', () => {
    expect(formatUZS(12500, 'uz')).toBe(`12${NBSP}500${NBSP}so\u2018m`);
  });

  it('formats ru', () => {
    expect(formatUZS(12500, 'ru')).toBe(`12${NBSP}500${NBSP}сум`);
  });

  it.each([
    [0, '0'],
    [7, '7'],
    [99, '99'],
    [100, '100'],
    [999, '999'],
    [1000, `1${NBSP}000`],
    [10000, `10${NBSP}000`],
    [100000, `100${NBSP}000`],
    [1234567, `1${NBSP}234${NBSP}567`],
    [1000000, `1${NBSP}000${NBSP}000`],
    [Number.MAX_SAFE_INTEGER, `9${NBSP}007${NBSP}199${NBSP}254${NBSP}740${NBSP}991`],
  ])('groups %i as %j', (amount, grouped) => {
    expect(formatUZS(amount, 'uz')).toBe(`${grouped}${NBSP}so\u2018m`);
    expect(formatUZS(amount, 'ru')).toBe(`${grouped}${NBSP}сум`);
  });

  it('supports negative amounts', () => {
    expect(formatUZS(-1, 'uz')).toBe(`-1${NBSP}so\u2018m`);
    expect(formatUZS(-12500, 'ru')).toBe(`-12${NBSP}500${NBSP}сум`);
    expect(formatUZS(-1000000, 'uz')).toBe(`-1${NBSP}000${NBSP}000${NBSP}so\u2018m`);
    expect(formatUZS(Number.MIN_SAFE_INTEGER, 'uz').startsWith('-9')).toBe(true);
  });

  it('never renders negative zero', () => {
    expect(formatUZS(-0, 'uz')).toBe(`0${NBSP}so\u2018m`);
  });

  it('uses only NBSP as whitespace', () => {
    expect(formatUZS(1234567, 'uz')).not.toMatch(/ /);
    expect(formatUZS(1234567, 'ru')).not.toMatch(/ /);
  });

  it.each([1.5, 0.1, -2.25, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'throws RangeError for non-integer or non-finite %s',
    (amount) => {
      expect(() => formatUZS(amount, 'uz')).toThrow(RangeError);
    },
  );

  it('throws RangeError for unsafe integers', () => {
    expect(() => formatUZS(Number.MAX_SAFE_INTEGER + 1, 'uz')).toThrow(RangeError);
    expect(() => formatUZS(Number.MIN_SAFE_INTEGER - 1, 'ru')).toThrow(RangeError);
    expect(() => formatUZS(2 ** 60, 'uz')).toThrow(RangeError);
  });
});
