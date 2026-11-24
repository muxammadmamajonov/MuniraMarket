import { describe, expect, it } from 'vitest';
import { uz } from '@/i18n/dictionaries/uz';
import { ru } from '@/i18n/dictionaries/ru';
import {
  ADDRESS_LIMITS,
  formatAddressLine,
  isCompleteAddress,
  isValidPoint,
  parseAddress,
  roundCoordinate,
  toAddressRequest,
  validateAddress,
  type Address,
} from './address';

function address(overrides: Partial<Address> = {}): Address {
  return {
    lat: 41.311081,
    lon: 69.240562,
    street: 'Amir Temur ko‘chasi',
    house: '15',
    apartment: '',
    entrance: '',
    floor: '',
    landmark: '',
    ...overrides,
  };
}

describe('isValidPoint', () => {
  it.each([
    [41.31, 69.24],
    [90, 180],
    [-90, -180],
    [0, 0],
  ])('accepts %s, %s', (lat, lon) => {
    expect(isValidPoint(lat, lon)).toBe(true);
  });

  it.each([
    [90.000001, 0],
    [0, -180.1],
    [Number.NaN, 69],
    [41, Number.POSITIVE_INFINITY],
    ['41.3', 69.2],
    [41.3, null],
    [undefined, undefined],
  ])('rejects %s, %s', (lat, lon) => {
    expect(isValidPoint(lat, lon)).toBe(false);
  });
});

describe('roundCoordinate', () => {
  it('rounds to six decimals', () => {
    expect(roundCoordinate(41.31108149)).toBe(41.311081);
    expect(roundCoordinate(69.2405625)).toBe(69.240563);
    expect(roundCoordinate(-0.0000004)).toBe(-0);
  });
});

describe('validateAddress', () => {
  it('accepts a complete address with the optional parts empty', () => {
    expect(validateAddress(address())).toEqual({});
    expect(isCompleteAddress(address())).toBe(true);
  });

  it('requires street and house (after trimming)', () => {
    expect(validateAddress(address({ street: '   ', house: '' }))).toEqual({
      street: { kind: 'required' },
      house: { kind: 'required' },
    });
  });

  it('mirrors the server limits at their exact edges', () => {
    const at = (field: keyof typeof ADDRESS_LIMITS, value: string) =>
      validateAddress(address({ [field]: value }))[field];
    expect(at('street', 'ab')).toBeUndefined();
    expect(at('street', 'a')).toEqual({ kind: 'tooShort', limit: 2 });
    expect(at('street', 'x'.repeat(200))).toBeUndefined();
    expect(at('street', 'x'.repeat(201))).toEqual({ kind: 'tooLong', limit: 200 });
    expect(at('house', '1')).toBeUndefined();
    expect(at('house', 'x'.repeat(32))).toBeUndefined();
    expect(at('house', 'x'.repeat(33))).toEqual({ kind: 'tooLong', limit: 32 });
    expect(at('apartment', 'x'.repeat(16))).toBeUndefined();
    expect(at('apartment', 'x'.repeat(17))).toEqual({ kind: 'tooLong', limit: 16 });
    expect(at('entrance', 'x'.repeat(16))).toBeUndefined();
    expect(at('entrance', 'x'.repeat(17))).toEqual({ kind: 'tooLong', limit: 16 });
    expect(at('floor', 'x'.repeat(8))).toBeUndefined();
    expect(at('floor', 'x'.repeat(9))).toEqual({ kind: 'tooLong', limit: 8 });
    expect(at('landmark', 'x'.repeat(200))).toBeUndefined();
    expect(at('landmark', 'x'.repeat(201))).toEqual({ kind: 'tooLong', limit: 200 });
  });

  it('counts characters like the server (code points, after trimming)', () => {
    expect(validateAddress(address({ house: '  😀  ' })).house).toBeUndefined();
    expect(validateAddress(address({ floor: '😀'.repeat(8) })).floor).toBeUndefined();
    expect(validateAddress(address({ floor: '😀'.repeat(9) })).floor?.kind).toBe('tooLong');
  });

  it('rejects line breaks and control characters (every part is one line)', () => {
    expect(validateAddress(address({ street: 'a\nb' })).street).toEqual({ kind: 'singleLine' });
    expect(validateAddress(address({ landmark: 'tab\there' })).landmark).toEqual({
      kind: 'singleLine',
    });
  });

  it('isCompleteAddress needs a valid point too', () => {
    expect(isCompleteAddress(null)).toBe(false);
    expect(isCompleteAddress(address({ lat: 95 }))).toBe(false);
    expect(isCompleteAddress(address({ lon: Number.NaN }))).toBe(false);
    expect(isCompleteAddress(address({ house: '' }))).toBe(false);
  });
});

describe('toAddressRequest', () => {
  it('trims, rounds the point to 6 decimals and leaves blank optional parts out', () => {
    const request = toAddressRequest(
      address({
        lat: 41.31108149,
        lon: 69.24056251,
        street: '  Amir Temur ko‘chasi ',
        house: ' 15 ',
        apartment: '  ',
        floor: ' 3 ',
      }),
    );
    expect(request).toEqual({
      lat: 41.311081,
      lon: 69.240563,
      street: 'Amir Temur ko‘chasi',
      house: '15',
      floor: '3',
    });
    expect(request).not.toHaveProperty('apartment');
    expect(request).not.toHaveProperty('entrance');
    expect(request).not.toHaveProperty('landmark');
  });

  it('keeps the keys in a fixed order (the idempotency fingerprint)', () => {
    const full = toAddressRequest(
      address({ landmark: 'Maktab yonida', floor: '2', entrance: '1', apartment: '4' }),
    );
    expect(Object.keys(full)).toEqual([
      'lat',
      'lon',
      'street',
      'house',
      'apartment',
      'entrance',
      'floor',
      'landmark',
    ]);
    // The same address typed in another order serializes identically.
    const shuffled: Address = {
      landmark: 'Maktab yonida',
      floor: '2',
      entrance: '1',
      apartment: '4',
      house: '15',
      street: 'Amir Temur ko‘chasi',
      lon: 69.240562,
      lat: 41.311081,
    };
    expect(JSON.stringify(toAddressRequest(shuffled))).toBe(JSON.stringify(full));
  });
});

describe('formatAddressLine', () => {
  const full = address({ apartment: ' 4 ', entrance: '2', floor: '3', landmark: 'Maktab' });

  it('writes one line with the Uzbek words, without the landmark', () => {
    expect(formatAddressLine(full, uz.address)).toBe(
      'Amir Temur ko‘chasi, 15, 4-xonadon, 2-podyezd, 3-qavat',
    );
  });

  it('writes one line with the Russian words', () => {
    expect(formatAddressLine(full, ru.address)).toBe(
      'Amir Temur ko‘chasi, 15, кв. 4, подъезд 2, этаж 3',
    );
  });

  it('skips blank parts', () => {
    expect(formatAddressLine(address({ entrance: '  ' }), uz.address)).toBe(
      'Amir Temur ko‘chasi, 15',
    );
    expect(formatAddressLine(address({ floor: '9' }), uz.address)).toBe(
      'Amir Temur ko‘chasi, 15, 9-qavat',
    );
  });
});

describe('parseAddress', () => {
  it('round-trips an address through JSON', () => {
    const value = address({ apartment: '4', landmark: 'Maktab' });
    expect(parseAddress(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });

  it('fills missing or null text parts with empty strings', () => {
    expect(parseAddress({ lat: 41.3, lon: 69.2, street: 'Ko‘cha', apartment: null })).toEqual({
      lat: 41.3,
      lon: 69.2,
      street: 'Ko‘cha',
      house: '',
      apartment: '',
      entrance: '',
      floor: '',
      landmark: '',
    });
  });

  it.each([
    ['null', null],
    ['a string', 'Amir Temur 15'],
    ['a number', 42],
    ['no point', { street: 'Ko‘cha', house: '1' }],
    ['a point as strings', { lat: '41.3', lon: '69.2', street: 'Ko‘cha', house: '1' }],
    ['latitude out of range', { lat: 91, lon: 69.2, street: 'Ko‘cha', house: '1' }],
    ['longitude out of range', { lat: 41.3, lon: -181, street: 'Ko‘cha', house: '1' }],
    ['a non-finite point', { lat: Number.NaN, lon: 69.2, street: 'Ko‘cha', house: '1' }],
    ['a text part of the wrong type', { lat: 41.3, lon: 69.2, street: 5, house: '1' }],
    ['an object as text', { lat: 41.3, lon: 69.2, street: 'Ko‘cha', house: { n: 1 } }],
  ])('rejects %s', (_name, value) => {
    expect(parseAddress(value)).toBeNull();
  });

  it('caps absurdly long stored text instead of trusting it', () => {
    const parsed = parseAddress({ lat: 41.3, lon: 69.2, street: 'x'.repeat(10_000), house: '1' });
    expect(parsed?.street.length).toBe(ADDRESS_LIMITS.street.max * 2);
  });
});
