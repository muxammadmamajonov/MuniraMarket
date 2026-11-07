/**
 * A small validator kit that reproduces what Pydantic v2 (lax mode, as FastAPI uses it) accepts,
 * normalises and reports for the storefront request models: `{loc, msg}` details in field order,
 * Pydantic's messages, `extra="forbid"` reported per key, Unicode-aware lengths and Python's
 * notion of whitespace for `strip_whitespace`. Submitted values are never echoed in a message.
 */
import type { ErrorDetail } from '../../errors.ts';
import { validationError } from '../../http/body.ts';

export type Loc = (string | number)[];
export const INVALID: unique symbol = Symbol('invalid');
export type Invalid = typeof INVALID;
export type Validator<T> = (value: unknown, loc: Loc, issues: ErrorDetail[]) => T | Invalid;

function fail(issues: ErrorDetail[], loc: Loc, msg: string): Invalid {
  issues.push({ loc: loc.map(String), msg });
  return INVALID;
}

// Python's str.isspace() set (what `str.strip()` removes).
const PY_WHITESPACE =
  '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_STRIP = new RegExp(`^[${PY_WHITESPACE}]+|[${PY_WHITESPACE}]+$`, 'gu');

/** `str.strip()` with Python's definition of whitespace (JS `trim()` differs slightly). */
export function pythonStrip(value: string): string {
  return value.replace(PY_STRIP, '');
}

/** Length in code points, like Python's `len(str)`. */
export function codePointLength(value: string): number {
  let length = 0;
  for (const _ of value) length += 1;
  return length;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Raised by `after` hooks; reported as Pydantic's `Value error, <message>`. */
export class ValueError extends Error {}

export interface StrOptions {
  min?: number;
  max?: number;
  strip?: boolean;
  /** Runs after the length checks (Pydantic `AfterValidator`); throw `ValueError` to refuse. */
  after?: (value: string) => string;
}

export function str(options: StrOptions = {}): Validator<string> {
  return (value, loc, issues) => {
    if (value === undefined) return fail(issues, loc, 'Field required');
    if (typeof value !== 'string') return fail(issues, loc, 'Input should be a valid string');
    const text = options.strip ? pythonStrip(value) : value;
    const length = codePointLength(text);
    if (options.min !== undefined && length < options.min) {
      return fail(issues, loc, `String should have at least ${plural(options.min, 'character')}`);
    }
    if (options.max !== undefined && length > options.max) {
      return fail(issues, loc, `String should have at most ${plural(options.max, 'character')}`);
    }
    if (options.after === undefined) return text;
    try {
      return options.after(text);
    } catch (error) {
      if (error instanceof ValueError) return fail(issues, loc, `Value error, ${error.message}`);
      throw error;
    }
  };
}

const INT_STRING = /^[+-]?\d+(?:_\d+)*(?:\.0*)?$/;

export interface IntOptions {
  ge?: number;
  le?: number;
}

/** Lax integer: ints, integral floats, booleans and numeric strings (like Pydantic). */
export function int(options: IntOptions = {}): Validator<number> {
  return (value, loc, issues) => {
    if (value === undefined) return fail(issues, loc, 'Field required');
    let number: number;
    if (typeof value === 'boolean') {
      number = value ? 1 : 0;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) return fail(issues, loc, 'Input should be a finite number');
      if (!Number.isInteger(value)) {
        return fail(
          issues,
          loc,
          'Input should be a valid integer, got a number with a fractional part',
        );
      }
      number = value;
    } else if (typeof value === 'string') {
      const text = pythonStrip(value);
      if (!INT_STRING.test(text)) {
        return fail(
          issues,
          loc,
          'Input should be a valid integer, unable to parse string as an integer',
        );
      }
      number = Number(text.replaceAll('_', '').replace(/\.0*$/, ''));
    } else {
      return fail(issues, loc, 'Input should be a valid integer');
    }
    if (options.ge !== undefined && number < options.ge) {
      return fail(issues, loc, `Input should be greater than or equal to ${options.ge}`);
    }
    if (options.le !== undefined && number > options.le) {
      return fail(issues, loc, `Input should be less than or equal to ${options.le}`);
    }
    return number === 0 ? 0 : number; // no -0
  };
}

const TRUE = new Set(['1', 'on', 't', 'true', 'y', 'yes']);
const FALSE = new Set(['0', 'off', 'f', 'false', 'n', 'no']);

/** Lax boolean as in query strings (`true`/`1`/`yes`/`on`/...). */
export function bool(): Validator<boolean> {
  return (value, loc, issues) => {
    if (value === undefined) return fail(issues, loc, 'Field required');
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1;
    if (typeof value === 'string') {
      const lowered = value.toLowerCase();
      if (TRUE.has(lowered)) return true;
      if (FALSE.has(lowered)) return false;
    }
    return fail(issues, loc, 'Input should be a valid boolean, unable to interpret input');
  };
}

function quoted(values: readonly string[]): string {
  const parts = values.map((v) => `'${v}'`);
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} or ${parts.at(-1)}`;
}

/** A `Literal`/`StrEnum` field: exact string match. */
export function oneOf<T extends string>(values: readonly T[]): Validator<T> {
  const allowed: ReadonlySet<string> = new Set(values);
  return (value, loc, issues) => {
    if (value === undefined) return fail(issues, loc, 'Field required');
    if (typeof value === 'string' && allowed.has(value)) return value as T;
    return fail(issues, loc, `Input should be ${quoted(values)}`);
  };
}

const UUID_FORMS = [
  /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i,
  /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/i,
  /^\{([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}$/i,
  /^urn:uuid:([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i,
];

/** Canonical (lower-case, hyphenated) UUID, or `null`. Accepts the forms Pydantic accepts. */
export function canonicalUuid(value: string): string | null {
  for (const form of UUID_FORMS) {
    const match = form.exec(value);
    if (match) return match.slice(1).join('-').toLowerCase();
  }
  return null;
}

export function uuid(): Validator<string> {
  return (value, loc, issues) => {
    if (value === undefined) return fail(issues, loc, 'Field required');
    if (typeof value !== 'string') {
      return fail(issues, loc, 'UUID input should be a string, bytes or UUID object');
    }
    return canonicalUuid(value) ?? fail(issues, loc, 'Input should be a valid UUID');
  };
}

/** `X | None = default`: absent -> `fallback`, `null` -> `null`, otherwise `inner`. */
export function nullable<T>(inner: Validator<T>, fallback: T | null = null): Validator<T | null> {
  return (value, loc, issues) => {
    if (value === undefined) return fallback;
    if (value === null) return null;
    return inner(value, loc, issues);
  };
}

/** `AfterValidator(lambda v: v or None)`: an empty string becomes `null`. */
export function blankToNull(inner: Validator<string | null>): Validator<string | null> {
  return (value, loc, issues) => {
    const result = inner(value, loc, issues);
    return result === '' ? null : result;
  };
}

export type Shape = Record<string, Validator<unknown>>;
export type Output<S extends Shape> = { [K in keyof S]: Exclude<ReturnType<S[K]>, Invalid> };

/** A Pydantic model with `extra="forbid"`; output keys keep the declaration order. */
export function model<S extends Shape>(shape: S): Validator<Output<S>> {
  const keys = Object.keys(shape);
  return (value, loc, issues) => {
    if (value === undefined) return fail(issues, loc, 'Field required');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail(
        issues,
        loc,
        'Input should be a valid dictionary or object to extract fields from',
      );
    }
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    let ok = true;
    for (const key of keys) {
      const validator = shape[key] as Validator<unknown>;
      const result = validator(
        Object.hasOwn(input, key) ? input[key] : undefined,
        [...loc, key],
        issues,
      );
      if (result === INVALID) ok = false;
      else output[key] = result;
    }
    for (const key of Object.keys(input)) {
      if (!Object.hasOwn(shape, key)) {
        fail(issues, [...loc, key], 'Extra inputs are not permitted');
        ok = false;
      }
    }
    return ok ? (output as Output<S>) : INVALID;
  };
}

/** Collects issues from several request parts, then throws one 422 (FastAPI's ordering). */
export class Validation {
  readonly issues: ErrorDetail[] = [];

  run<T>(validator: Validator<T>, value: unknown, loc: Loc): T | Invalid {
    return validator(value, loc, this.issues);
  }

  /** Throw `422 validation_error` if anything failed. */
  check(): void {
    if (this.issues.length > 0) throw validationError(this.issues);
  }
}

/** Narrow after `Validation.check()` (which throws when any value is `INVALID`). */
export function valid<T>(value: T | Invalid): T {
  if (value === INVALID) throw new Error('validated value missing');
  return value;
}
