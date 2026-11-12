/**
 * Shared plumbing of the admin route modules (catalog, CSV, users, audit, dashboard):
 * request validation with Pydantic v2 (lax mode) semantics and messages, FastAPI's dependency /
 * validation order, and common response helpers.
 *
 * FastAPI order, reproduced by every admin handler:
 * 1. the JSON body is read and decoded first (malformed JSON is `422` before anything else);
 * 2. dependencies run (router: admin IP limit + back-office session; route: rate limits; then the
 *    role check), and the first one that raises decides the response;
 * 3. only then are path, query and body validation errors reported, together, as one `422`.
 */

import { ApiError, type ErrorDetail } from '../errors.ts';
import { readRawBody, validationError, bodyLimitFor, payloadTooLarge } from '../http/body.ts';
import type { Ctx } from '../http/context.ts';
import { pyLen, pyStrip } from '../domain/text.ts';

export type Loc = readonly string[];
export type Issues = ErrorDetail[];

/** Sentinel for "this value failed validation" (the issue is already recorded). */
export const INVALID: unique symbol = Symbol('invalid');
export type Invalid = typeof INVALID;

/** A Pydantic-like validator: returns the value or records issues and returns `INVALID`. */
export type V<T> = (value: unknown, loc: Loc, issues: Issues) => T | Invalid;

/** A raised Python `ValueError` inside a validator: rendered as `Value error, <message>`. */
export class ValueErr extends Error {}

const issue = (issues: Issues, loc: Loc, msg: string): Invalid => {
  issues.push({ loc: [...loc], msg });
  return INVALID;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// --- scalars --------------------------------------------------------------------------------------

export interface StrOptions {
  strip?: boolean;
  minLength?: number;
  maxLength?: number;
  /** `[regex, python pattern text]` (the text is what the error message shows). */
  pattern?: readonly [RegExp, string];
}

export function str(options: StrOptions = {}): V<string> {
  return (value, loc, issues) => {
    if (typeof value !== 'string') return issue(issues, loc, 'Input should be a valid string');
    const text = options.strip ? pyStrip(value) : value;
    const length = pyLen(text);
    if (options.minLength !== undefined && length < options.minLength) {
      const unit = options.minLength === 1 ? 'character' : 'characters';
      return issue(issues, loc, `String should have at least ${options.minLength} ${unit}`);
    }
    if (options.maxLength !== undefined && length > options.maxLength) {
      const unit = options.maxLength === 1 ? 'character' : 'characters';
      return issue(issues, loc, `String should have at most ${options.maxLength} ${unit}`);
    }
    if (options.pattern && !options.pattern[0].test(text)) {
      return issue(issues, loc, `String should match pattern '${options.pattern[1]}'`);
    }
    return text;
  };
}

const INT_STRING = /^\s*[+-]?\d+(_\d+)*\s*$/;
const FLOAT_STRING = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/;

export interface IntOptions {
  ge?: number;
  le?: number;
}

/** Pydantic lax `int`: ints, integral floats, bools and numeric strings. */
export function int(options: IntOptions = {}): V<number> {
  return (value, loc, issues) => {
    let number: number;
    if (typeof value === 'boolean') {
      number = value ? 1 : 0;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        return issue(issues, loc, 'Input should be a finite number');
      }
      if (!Number.isInteger(value)) {
        return issue(
          issues,
          loc,
          'Input should be a valid integer, got a number with a fractional part',
        );
      }
      number = value;
    } else if (typeof value === 'string') {
      if (INT_STRING.test(value)) {
        number = Number(value.trim().replaceAll('_', ''));
      } else if (FLOAT_STRING.test(value) && Number.isInteger(Number(value.trim()))) {
        number = Number(value.trim());
      } else {
        return issue(
          issues,
          loc,
          'Input should be a valid integer, unable to parse string as an integer',
        );
      }
    } else {
      return issue(issues, loc, 'Input should be a valid integer');
    }
    if (options.ge !== undefined && number < options.ge) {
      return issue(issues, loc, `Input should be greater than or equal to ${options.ge}`);
    }
    if (options.le !== undefined && number > options.le) {
      return issue(issues, loc, `Input should be less than or equal to ${options.le}`);
    }
    return number;
  };
}

const TRUE_STRINGS = new Set(['1', 'on', 't', 'true', 'y', 'yes']);
const FALSE_STRINGS = new Set(['0', 'off', 'f', 'false', 'n', 'no']);

/** Pydantic lax `bool`. */
export const bool: V<boolean> = (value, loc, issues) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return issue(issues, loc, 'Input should be a valid boolean, unable to interpret input');
  }
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    if (TRUE_STRINGS.has(lowered)) return true;
    if (FALSE_STRINGS.has(lowered)) return false;
    return issue(issues, loc, 'Input should be a valid boolean, unable to interpret input');
  }
  return issue(issues, loc, 'Input should be a valid boolean');
};

const UUID_HYPHENATED =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UUID_SIMPLE = /^[0-9a-fA-F]{32}$/;

/** Canonical lower-case hyphenated UUID text, or `null`. Accepts the forms Pydantic does. */
export function parseUuid(raw: string): string | null {
  let text = raw;
  if (/^urn:uuid:/i.test(text)) text = text.slice(9);
  else if (text.startsWith('{') && text.endsWith('}')) text = text.slice(1, -1);
  let hex: string;
  if (UUID_HYPHENATED.test(text)) hex = text.replaceAll('-', '');
  else if (UUID_SIMPLE.test(text)) hex = text;
  else return null;
  hex = hex.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const uuid: V<string> = (value, loc, issues) => {
  if (typeof value !== 'string')
    return issue(issues, loc, 'UUID input should be a string, bytes or UUID object');
  return parseUuid(value) ?? issue(issues, loc, 'Input should be a valid UUID');
};

function pyRepr(values: readonly string[]): string {
  const quoted = values.map((value) => `'${value}'`);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`;
}

/** A `StrEnum` / `Literal[...]` of strings. */
export function oneOf<T extends string>(values: readonly T[]): V<T> {
  const allowed: ReadonlySet<string> = new Set(values);
  const message = `Input should be ${pyRepr(values)}`;
  return (value, loc, issues) =>
    typeof value === 'string' && allowed.has(value) ? (value as T) : issue(issues, loc, message);
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` (Pydantic `date`), returned in that form. */
export const date: V<string> = (value, loc, issues) => {
  if (typeof value !== 'string') return issue(issues, loc, 'Input should be a valid date');
  const match = DATE.exec(value);
  if (!match) {
    return issue(
      issues,
      loc,
      'Input should be a valid date or datetime, invalid date separator, expected `-`',
    );
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12) {
    return issue(
      issues,
      loc,
      'Input should be a valid date or datetime, month value is outside expected range of 1-12',
    );
  }
  if (day < 1 || day > last) {
    return issue(
      issues,
      loc,
      'Input should be a valid date or datetime, day value is outside expected range',
    );
  }
  return value;
};

/** `X | None`: `null` passes, anything else goes through `inner`. */
export function nullable<T>(inner: V<T>): V<T | null> {
  return (value, loc, issues) => (value === null ? null : inner(value, loc, issues));
}

/** `Annotated[..., AfterValidator(fn)]`: `fn` may throw `ValueErr`. */
export function after<T, U>(inner: V<T>, fn: (value: T) => U): V<U> {
  return (value, loc, issues) => {
    const result = inner(value, loc, issues);
    if (result === INVALID) return INVALID;
    try {
      return fn(result);
    } catch (error) {
      if (error instanceof ValueErr) return issue(issues, loc, `Value error, ${error.message}`);
      throw error;
    }
  };
}

/** `BeforeValidator(fn)`: `fn` maps the raw input (may throw `ValueErr`). */
export function before<T>(fn: (value: unknown) => T): V<T> {
  return (value, loc, issues) => {
    try {
      return fn(value);
    } catch (error) {
      if (error instanceof ValueErr) return issue(issues, loc, `Value error, ${error.message}`);
      throw error;
    }
  };
}

export function list<T>(
  item: V<T>,
  options: { minLength?: number; maxLength?: number } = {},
): V<T[]> {
  return (value, loc, issues) => {
    if (!Array.isArray(value)) return issue(issues, loc, 'Input should be a valid list');
    const out: T[] = [];
    let failed = false;
    value.forEach((element, index) => {
      const parsed = item(element, [...loc, String(index)], issues);
      if (parsed === INVALID) failed = true;
      else out.push(parsed);
    });
    if (failed) return INVALID;
    if (options.minLength !== undefined && out.length < options.minLength) {
      const unit = options.minLength === 1 ? 'item' : 'items';
      return issue(
        issues,
        loc,
        `List should have at least ${options.minLength} ${unit} after validation, not ${out.length}`,
      );
    }
    if (options.maxLength !== undefined && out.length > options.maxLength) {
      const unit = options.maxLength === 1 ? 'item' : 'items';
      return issue(
        issues,
        loc,
        `List should have at most ${options.maxLength} ${unit} after validation, not ${out.length}`,
      );
    }
    return out;
  };
}

// --- models ---------------------------------------------------------------------------------------

export interface FieldSpec {
  validator: V<unknown>;
  /** Absent from the input: use this default (no validation, like Pydantic). */
  default?: unknown;
  required?: boolean;
}

export const required = (validator: V<unknown>): FieldSpec => ({ validator, required: true });
export const optional = (validator: V<unknown>, defaultValue: unknown = null): FieldSpec => ({
  validator,
  default: defaultValue,
});

export interface ModelResult {
  values: Record<string, unknown>;
  /** `model_fields_set`: the fields present in the input. */
  fieldsSet: Set<string>;
}

/**
 * A `BaseModel` with `extra="forbid"`: fields in declaration order, then the model-level
 * `after` check (only when every field is valid; a `ValueErr` is reported at `loc`).
 */
export function model(
  fields: Readonly<Record<string, FieldSpec>>,
  afterModel?: (result: ModelResult) => void,
): V<ModelResult> {
  return (value, loc, issues) => {
    if (!isPlainObject(value)) {
      return issue(
        issues,
        loc,
        'Input should be a valid dictionary or object to extract fields from',
      );
    }
    const values: Record<string, unknown> = {};
    const fieldsSet = new Set<string>();
    let failed = false;
    for (const [name, spec] of Object.entries(fields)) {
      if (!Object.hasOwn(value, name)) {
        if (spec.required) {
          issue(issues, [...loc, name], 'Field required');
          failed = true;
        } else {
          values[name] = spec.default;
        }
        continue;
      }
      fieldsSet.add(name);
      const parsed = spec.validator(value[name], [...loc, name], issues);
      if (parsed === INVALID) failed = true;
      else values[name] = parsed;
    }
    for (const name of Object.keys(value)) {
      if (!Object.hasOwn(fields, name)) {
        issue(issues, [...loc, name], 'Extra inputs are not permitted');
        failed = true;
      }
    }
    if (failed) return INVALID;
    const result = { values, fieldsSet };
    if (afterModel) {
      try {
        afterModel(result);
      } catch (error) {
        if (error instanceof ValueErr) return issue(issues, loc, `Value error, ${error.message}`);
        throw error;
      }
    }
    return result;
  };
}

// --- request plumbing -----------------------------------------------------------------------------

/** The body-size middleware's early check on a declared `Content-Length`. */
export function checkDeclaredLength(c: Ctx): void {
  const declared = c.req.header('content-length');
  if (
    declared !== undefined &&
    /^\d+$/.test(declared) &&
    Number(declared) > bodyLimitFor(c.req.path)
  ) {
    throw payloadTooLarge();
  }
}

/** Marker for "no body was sent" (FastAPI then reports `Field required` after the deps). */
export const NO_BODY: unique symbol = Symbol('no body');

/**
 * Step 1 of FastAPI's order: read and decode the JSON body before any dependency runs. Returns
 * the decoded value (a raw string for a non-JSON content type, like FastAPI) or `NO_BODY`.
 */
export async function readJsonBody(c: Ctx): Promise<unknown> {
  checkDeclaredLength(c);
  const raw = await readRawBody(c);
  if (raw.length === 0) return NO_BODY;
  const contentType = c.req.header('content-type');
  let isJson = true;
  if (contentType) {
    const media = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    const [main, sub = ''] = media.split('/');
    isJson = main === 'application' && (sub === 'json' || sub.endsWith('+json'));
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw validationError([{ loc: ['body', '0'], msg: 'JSON decode error' }]);
  }
  if (!isJson) return text;
  try {
    return JSON.parse(text);
  } catch (error) {
    const position = /position (\d+)/.exec(String(error))?.[1] ?? '0';
    throw validationError([{ loc: ['body', position], msg: 'JSON decode error' }]);
  }
}

/** Validate an already-read body against a model (after the dependencies ran). */
export function validateBody(
  body: unknown,
  schema: V<ModelResult>,
  issues: Issues,
): ModelResult | Invalid {
  if (body === NO_BODY) return issue(issues, ['body'], 'Field required');
  return schema(body, ['body'], issues);
}

/** One path parameter (UUID). */
export function pathUuid(c: Ctx, name: string, issues: Issues): string | Invalid {
  return uuid(c.req.param(name), ['path', name], issues);
}

/** Query parameters: the last value of a repeated key wins, like FastAPI for scalars. */
export function queryValues(c: Ctx): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of new URL(c.req.url).searchParams) values[key] = value;
  return values;
}

/** Validate one optional query parameter (`default` when absent). */
export function queryParam<T>(
  query: Readonly<Record<string, string>>,
  name: string,
  validator: V<T>,
  defaultValue: T,
  issues: Issues,
): T | Invalid {
  if (!Object.hasOwn(query, name)) return defaultValue;
  return validator(query[name], ['query', name], issues);
}

/** Step 3: report every collected validation issue as one `422`. */
export function throwIfInvalid(issues: Issues): void {
  if (issues.length > 0) throw validationError(issues);
}

/** Narrow after `throwIfInvalid` (values cannot be `INVALID` then). */
export function ok<T>(value: T | Invalid): T {
  if (value === INVALID) throw new Error('validated value missing');
  return value;
}

export function pageOf<T>(items: T[], page: number, pageSize: number, total: number) {
  return { items, page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) };
}

export const noContent = (): Response => new Response(null, { status: 204 });

export const internalError = (): ApiError =>
  new ApiError(500, 'internal_error', 'Internal server error');

/** The PostgreSQL constraint a `pg` error names, if any (unique / foreign key violations). */
export function violatedConstraint(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  if (code !== '23505' && code !== '23503') return null;
  return typeof constraint === 'string' ? constraint : null;
}

/** Hono route-level `c.json` replacement that keeps the exact key order and status. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
