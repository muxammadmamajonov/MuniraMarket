/** Pydantic-compatible request validation used by the admin routes (src/routes/adminCommon.ts). */
import { describe, expect, it } from 'vitest';
import {
  after,
  bool,
  date,
  int,
  INVALID,
  list,
  model,
  nullable,
  oneOf,
  optional,
  parseUuid,
  required,
  str,
  uuid,
  ValueErr,
  type Issues,
  type V,
} from '../../../src/routes/adminCommon.ts';

function run<T>(validator: V<T>, value: unknown): { value: T | typeof INVALID; issues: Issues } {
  const issues: Issues = [];
  return { value: validator(value, ['body', 'f'], issues), issues };
}
const msg = <T>(validator: V<T>, value: unknown) => run(validator, value).issues[0]?.msg;

describe('scalars', () => {
  it('str: strip, lengths in code points, pattern', () => {
    const v = str({
      strip: true,
      minLength: 1,
      maxLength: 3,
      pattern: [/^[a-z🍎]+$/u, '^[a-z]+$'],
    });
    expect(run(v, '  ab \u3000').value).toBe('ab');
    expect(run(v, '🍎🍎🍎').value).toBe('🍎🍎🍎');
    expect(msg(v, '   ')).toBe('String should have at least 1 character');
    expect(msg(v, 'abcd')).toBe('String should have at most 3 characters');
    expect(msg(v, 'A')).toBe("String should match pattern '^[a-z]+$'");
    expect(msg(v, 5)).toBe('Input should be a valid string');
  });

  it('int: lax like Pydantic', () => {
    const v = int({ ge: 0, le: 10 });
    expect(run(v, 5).value).toBe(5);
    expect(run(v, '7').value).toBe(7);
    expect(run(v, 3.0).value).toBe(3);
    expect(run(v, true).value).toBe(1);
    expect(msg(v, 2.5)).toBe(
      'Input should be a valid integer, got a number with a fractional part',
    );
    expect(msg(v, 'x')).toBe(
      'Input should be a valid integer, unable to parse string as an integer',
    );
    expect(msg(v, null)).toBe('Input should be a valid integer');
    expect(msg(v, -1)).toBe('Input should be greater than or equal to 0');
    expect(msg(v, 11)).toBe('Input should be less than or equal to 10');
  });

  it('bool: lax like Pydantic', () => {
    for (const truthy of [true, 1, 'true', 'TRUE', 'yes', 'on', 't', 'y', '1'])
      expect(run(bool, truthy).value).toBe(true);
    for (const falsy of [false, 0, 'false', 'no', 'off', 'f', 'n', '0'])
      expect(run(bool, falsy).value).toBe(false);
    expect(msg(bool, 'maybe')).toBe('Input should be a valid boolean, unable to interpret input');
    expect(msg(bool, 2)).toBe('Input should be a valid boolean, unable to interpret input');
    expect(msg(bool, null)).toBe('Input should be a valid boolean');
  });

  it('uuid: canonical lower-case text from the accepted forms', () => {
    const canonical = '0b8f6a52-7c1e-4e0e-9d0e-5c8d2f1b7a10';
    for (const form of [
      canonical,
      canonical.toUpperCase(),
      canonical.replaceAll('-', ''),
      `urn:uuid:${canonical}`,
      `{${canonical}}`,
    ]) {
      expect(parseUuid(form)).toBe(canonical);
    }
    expect(parseUuid('0b8f6a52-7c1e-4e0e-9d0e')).toBeNull();
    expect(msg(uuid, 'nope')).toBe('Input should be a valid UUID');
  });

  it('oneOf renders choices like Pydantic', () => {
    expect(msg(oneOf(['a', 'b', 'c']), 'x')).toBe("Input should be 'a', 'b' or 'c'");
    expect(msg(oneOf(['only']), 'x')).toBe("Input should be 'only'");
  });

  it('date', () => {
    expect(run(date, '2026-11-02').value).toBe('2026-11-02');
    expect(run(date, '2026-02-30').value).toBe(INVALID);
    expect(run(date, '2026/11/02').value).toBe(INVALID);
  });

  it('list with lengths and an after-validator', () => {
    const v = after(list(oneOf(['a', 'b']), { minLength: 1, maxLength: 2 }), (items) => {
      if (new Set(items).size !== items.length) throw new ValueErr('must not repeat');
      return items;
    });
    expect(run(v, ['a', 'b']).value).toEqual(['a', 'b']);
    expect(run(v, ['a', 'x']).issues).toEqual([
      { loc: ['body', 'f', '1'], msg: "Input should be 'a' or 'b'" },
    ]);
    expect(msg(v, [])).toBe('List should have at least 1 item after validation, not 0');
    expect(msg(v, ['a', 'b', 'a'])).toBe(
      'List should have at most 2 items after validation, not 3',
    );
    expect(msg(v, ['a', 'a'])).toBe('Value error, must not repeat');
    expect(msg(v, 'a')).toBe('Input should be a valid list');
  });
});

describe('model', () => {
  const v = model({ a: required(int()), b: optional(nullable(str()), 'default') }, ({ values }) => {
    if (values['a'] === 0) throw new ValueErr('a must not be zero');
  });

  it('defaults, fields set, extras and model checks', () => {
    const ok = run(v, { a: 1 });
    expect(ok.value).toEqual({ values: { a: 1, b: 'default' }, fieldsSet: new Set(['a']) });
    expect(run(v, { a: 1, b: null }).value).toEqual({
      values: { a: 1, b: null },
      fieldsSet: new Set(['a', 'b']),
    });
    expect(run(v, { b: 'x', c: 1 }).issues).toEqual([
      { loc: ['body', 'f', 'a'], msg: 'Field required' },
      { loc: ['body', 'f', 'c'], msg: 'Extra inputs are not permitted' },
    ]);
    expect(run(v, { a: 0 }).issues).toEqual([
      { loc: ['body', 'f'], msg: 'Value error, a must not be zero' },
    ]);
    expect(msg(v, [1])).toBe('Input should be a valid dictionary or object to extract fields from');
  });
});
