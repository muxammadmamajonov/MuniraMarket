/**
 * Profile hub rules and request models (port of services/api/tests/test_profile_api.py): phone
 * normalisation, birth-date bounds, names, saved-address limits, with the reference's messages.
 */
import { describe, expect, it } from 'vitest';
import {
  checkBirthDate,
  normalizeProfilePhone,
  parseBirthDate,
  tashkentToday,
} from '../../../src/domain/profile.ts';
import { ORDER_STATUS_GROUP_STATUSES, ORDER_STATUSES } from '../../../src/domain/orderStatus.ts';
import { MAX_SAVED_ADDRESSES } from '../../../src/repositories/addresses.ts';
import { INVALID } from '../../../src/schemas/storefront/fields.ts';
import {
  orderPageQuery,
  savedAddressRequest,
  updateProfileRequest,
} from '../../../src/schemas/storefront/requests.ts';

type Issue = { loc: string[]; msg: string };

function validate<T>(
  validator: (v: unknown, l: (string | number)[], i: Issue[]) => T,
  value: unknown,
  loc: (string | number)[] = [],
) {
  const issues: Issue[] = [];
  const result = validator(value, loc, issues);
  return { result, issues };
}

const errors = (validator: Parameters<typeof validate>[0], value: unknown) =>
  validate(validator, value).issues.map((issue) => [issue.loc, issue.msg]);

describe('profile phone', () => {
  it.each([
    '+998901234567',
    '998901234567',
    '901234567',
    '+998 90 123 45 67',
    '(90) 123-45-67',
    ' 90 123 45 67 ',
    '+998 (90) 123-45-67',
  ])('accepts %s', (raw) => {
    expect(normalizeProfilePhone(raw)).toBe('+998901234567');
  });

  it.each([
    '',
    '12345678',
    '9012345678',
    '+79123456789',
    '+99890123456',
    '+9989012345678',
    '+901234567',
    '998+901234567',
    'tel:901234567',
    '90.123.45.67',
    '٩٠١٢٣٤٥٦٧',
  ])('refuses %j', (raw) => {
    expect(() => normalizeProfilePhone(raw)).toThrow(/Uzbekistan/);
  });
});

describe('birth date', () => {
  it('is bounded by 1900-01-01 and today (inclusive)', () => {
    expect(checkBirthDate('1900-01-01', '2026-11-13')).toBe('1900-01-01');
    expect(checkBirthDate('2026-11-13', '2026-11-13')).toBe('2026-11-13');
    expect(() => checkBirthDate('1899-12-31', '2026-11-13')).toThrow(/between/);
    expect(() => checkBirthDate('2026-11-14', '2026-11-13')).toThrow(/between/);
  });

  it.each(['2000-1-01', '2000/01/01', '2000-02-30', '2001-02-29', '0000-01-01', '20000101'])(
    'refuses the format %j',
    (raw) => {
      expect(() => parseBirthDate(raw)).toThrow(/YYYY-MM-DD/);
    },
  );

  it('accepts real days, leap days included', () => {
    expect(parseBirthDate('2000-02-29')).toBe('2000-02-29');
    expect(parseBirthDate('1990-12-31')).toBe('1990-12-31');
    expect(() => parseBirthDate('1900-02-29')).toThrow(/YYYY-MM-DD/);
    expect(() => parseBirthDate(20000101)).toThrow(/YYYY-MM-DD/);
  });

  it('uses the Asia/Tashkent calendar day (UTC+5)', () => {
    expect(tashkentToday(Date.parse('2026-11-13T18:59:00Z'))).toBe('2026-11-13');
    expect(tashkentToday(Date.parse('2026-11-13T19:00:00Z'))).toBe('2026-11-14');
  });
});

describe('UpdateProfileRequest', () => {
  it('trims names, turns a blank last name into null and keeps unsent keys undefined', () => {
    const { result, issues } = validate(updateProfileRequest, {
      first_name: '  Aziza ',
      last_name: '   ',
    });
    expect(issues).toEqual([]);
    expect(result).toEqual({
      first_name: 'Aziza',
      last_name: null,
      birth_date: undefined,
      phone: undefined,
    });
    expect(validate(updateProfileRequest, { first_name: 'Ш'.repeat(64) }).issues).toEqual([]);
  });

  it('reports the reference messages', () => {
    expect(errors(updateProfileRequest, { username: 'x' })).toEqual([
      [['username'], 'Extra inputs are not permitted'],
    ]);
    expect(errors(updateProfileRequest, { first_name: null })).toEqual([
      [['first_name'], 'Input should be a valid string'],
    ]);
    expect(errors(updateProfileRequest, { first_name: '  ' })).toEqual([
      [['first_name'], 'String should have at least 1 character'],
    ]);
    expect(errors(updateProfileRequest, { first_name: 'a'.repeat(65) })).toEqual([
      [['first_name'], 'String should have at most 64 characters'],
    ]);
    expect(errors(updateProfileRequest, { first_name: 'Az\niza' })).toEqual([
      [['first_name'], 'Value error, must be a single line of text'],
    ]);
    expect(errors(updateProfileRequest, { last_name: 'Ka\u0000rimova' })).toEqual([
      [['last_name'], 'Value error, must be a single line of text'],
    ]);
    expect(errors(updateProfileRequest, { phone: '+7 912 345 67 89' })).toEqual([
      [
        ['phone'],
        'Value error, phone must be an Uzbekistan number: +998 and 9 digits, or the 9 digits alone',
      ],
    ]);
    expect(errors(updateProfileRequest, { phone: '9'.repeat(33) })).toEqual([
      [['phone'], 'String should have at most 32 characters'],
    ]);
  });

  it('validates the birth date', () => {
    const today = tashkentToday();
    const future = new Date(Date.parse(`${today}T00:00:00Z`) + 2 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(validate(updateProfileRequest, { birth_date: '1990-05-17' }).result).toMatchObject({
      birth_date: '1990-05-17',
    });
    expect(validate(updateProfileRequest, { birth_date: null }).result).toMatchObject({
      birth_date: null,
    });
    expect(validate(updateProfileRequest, { birth_date: today }).issues).toEqual([]);
    const range = 'Value error, birth_date must be between 1900-01-01 and today';
    const format = 'Value error, birth_date must be a date in YYYY-MM-DD format';
    expect(errors(updateProfileRequest, { birth_date: '1899-12-31' })).toEqual([
      [['birth_date'], range],
    ]);
    expect(errors(updateProfileRequest, { birth_date: future })).toEqual([[['birth_date'], range]]);
    for (const bad of ['1990-02-30', '17.05.1990', 19900517]) {
      expect(errors(updateProfileRequest, { birth_date: bad })).toEqual([[['birth_date'], format]]);
    }
  });

  it('normalises the phone and clears it with null', () => {
    expect(validate(updateProfileRequest, { phone: '90 123 45 67' }).result).toMatchObject({
      phone: '+998901234567',
    });
    expect(validate(updateProfileRequest, { phone: null }).result).toMatchObject({ phone: null });
  });

  it('accepts an empty object here (the route refuses it: at least one key)', () => {
    const { result } = validate(updateProfileRequest, {});
    expect(result).not.toBe(INVALID);
    expect(Object.values(result as object).every((value) => value === undefined)).toBe(true);
  });
});

describe('SavedAddressRequest', () => {
  const address = { lat: 41.3110812, lon: 69.2405624, street: ' Amir Temur ', house: '1' };

  it('reuses the delivery address rules and adds label / is_default', () => {
    const { result, issues } = validate(savedAddressRequest, {
      ...address,
      label: '  Uy ',
      apartment: ' ',
    });
    expect(issues).toEqual([]);
    expect(result).toEqual({
      lat: 41.311081,
      lon: 69.240562,
      street: 'Amir Temur',
      house: '1',
      apartment: null,
      entrance: null,
      floor: null,
      landmark: null,
      label: 'Uy',
      is_default: undefined,
    });
    expect(validate(savedAddressRequest, { ...address, label: ' ' }).result).toMatchObject({
      label: null,
    });
    expect(validate(savedAddressRequest, { ...address, is_default: true }).result).toMatchObject({
      is_default: true,
    });
  });

  it('reports the reference messages', () => {
    expect(errors(savedAddressRequest, { ...address, label: 'x'.repeat(33) })).toEqual([
      [['label'], 'String should have at most 32 characters'],
    ]);
    expect(errors(savedAddressRequest, { ...address, label: 'a\tb' })).toEqual([
      [['label'], 'Value error, must be a single line of text'],
    ]);
    expect(errors(savedAddressRequest, { ...address, is_default: null })).toEqual([
      [['is_default'], 'Input should be a valid boolean'],
    ]);
    expect(errors(savedAddressRequest, { ...address, district: 'x' })).toEqual([
      [['district'], 'Extra inputs are not permitted'],
    ]);
    expect(errors(savedAddressRequest, { ...address, lat: 91 })).toEqual([
      [['lat'], 'Input should be less than or equal to 90'],
    ]);
    expect(errors(savedAddressRequest, { ...address, floor: '123456789' })).toEqual([
      [['floor'], 'String should have at most 8 characters'],
    ]);
    expect(errors(savedAddressRequest, { ...address, landmark: 'x'.repeat(201) })).toEqual([
      [['landmark'], 'String should have at most 200 characters'],
    ]);
    expect(errors(savedAddressRequest, { lat: 1 })[0]).toEqual([['lon'], 'Field required']);
  });

  it('allows ten saved addresses per user', () => {
    expect(MAX_SAVED_ADDRESSES).toBe(10);
  });
});

describe('order status groups', () => {
  it('defaults to all and refuses unknown groups with the enum message', () => {
    expect(validate(orderPageQuery.status_group, undefined).result).toBe('all');
    expect(validate(orderPageQuery.status_group, 'done').result).toBe('done');
    expect(errors(orderPageQuery.status_group, 'open')).toEqual([
      [[], "Input should be 'all', 'active', 'delivering', 'done' or 'cancelled'"],
    ]);
  });

  it('partitions the statuses', () => {
    expect(ORDER_STATUS_GROUP_STATUSES.all).toEqual(ORDER_STATUSES);
    const grouped = (['active', 'delivering', 'done', 'cancelled'] as const).flatMap((group) => [
      ...ORDER_STATUS_GROUP_STATUSES[group],
    ]);
    expect([...grouped].sort()).toEqual([...ORDER_STATUSES].sort());
  });
});
