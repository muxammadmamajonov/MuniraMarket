/**
 * Request parts read the way FastAPI reads them, so the same error wins:
 * - the JSON body is decoded BEFORE any dependency runs (malformed JSON is 422 even without a
 *   session), but validated only after the dependencies (401/403/429 win over a bad body);
 * - query, path and header parameters are validated after the dependencies too, and their errors
 *   are reported together with the body's (path, query, header, then body).
 */
import { readRawBody, validationError } from '../../http/body.ts';
import type { Ctx } from '../../http/context.ts';
import type { Output, Shape, Validation, Validator } from './fields.ts';

/** Marks a body that is present but is not JSON (validation then says "not an object"). */
export const NOT_JSON: unique symbol = Symbol('not-json');

function isJsonContentType(value: string): boolean {
  const media = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const [type, subtype = ''] = media.split('/', 2);
  return type === 'application' && (subtype === 'json' || subtype.endsWith('+json'));
}

/**
 * The decoded body: `undefined` when empty (FastAPI: body missing), `NOT_JSON` for a non-JSON
 * content type, otherwise the parsed value. Malformed JSON is `422` right away.
 */
export async function readJsonBody(c: Ctx): Promise<unknown> {
  const raw = await readRawBody(c);
  if (raw.byteLength === 0) return undefined;
  const contentType = c.req.header('content-type');
  if (contentType !== undefined && contentType !== '' && !isJsonContentType(contentType)) {
    return NOT_JSON;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown;
  } catch {
    throw validationError([{ loc: ['body', '0'], msg: 'JSON decode error' }]);
  }
}

/** Query parameters (a repeated key keeps its last value, like FastAPI for scalar params). */
export function queryValues(c: Ctx): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of new URL(c.req.url).searchParams) values[key] = value;
  return values;
}

/**
 * Validate the query parameters named in `shape` (unknown keys are ignored, like FastAPI). The
 * result is only meaningful after `validation.check()` (which throws on any failure).
 */
export function readQuery<S extends Shape>(validation: Validation, c: Ctx, shape: S): Output<S> {
  const values = queryValues(c);
  const out: Record<string, unknown> = {};
  for (const [key, validator] of Object.entries(shape)) {
    out[key] = validation.run(validator, Object.hasOwn(values, key) ? values[key] : undefined, [
      'query',
      key,
    ]);
  }
  return out as Output<S>;
}

/** Validate one path parameter (`loc: ['path', name]`); see `readQuery` about `check()`. */
export function readPath<T>(
  validation: Validation,
  c: Ctx,
  name: string,
  validator: Validator<T>,
): T {
  return validation.run(validator, c.req.param(name), ['path', name]) as T;
}

/** Validate a body read by `readJsonBody` (`loc: ['body', ...]`); see `readQuery`. */
export function readBody<T>(validation: Validation, body: unknown, validator: Validator<T>): T {
  return validation.run(validator, body, ['body']) as T;
}
