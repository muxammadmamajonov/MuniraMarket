import type { z } from 'zod';
import { ApiError, type ErrorDetail } from '../errors.ts';
import type { Ctx } from './context.ts';

/**
 * Request body/query parsing with the FastAPI reference's limits and error shapes:
 * - bodies are capped while streaming (a lying Content-Length or chunked encoding cannot bypass
 *   it): 64 KiB by default, larger only for the routes listed in `BODY_LIMITS`;
 * - invalid input is `422 validation_error` with `details: [{loc, msg}]`; submitted values are
 *   never echoed back.
 */

export const API_PREFIX = '/api/v1';
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
export const BODY_LIMITS: Readonly<Record<string, number>> = {
  // initData is capped at 4096 characters; leave room for JSON framing.
  [`${API_PREFIX}/auth/telegram/init-data`]: 8 * 1024,
  [`${API_PREFIX}/auth/telegram/oidc/start`]: 2 * 1024,
  // Catalog CSV import (admin only): the one route allowed a body above the default.
  [`${API_PREFIX}/admin/catalog/csv/import`]: 1024 * 1024,
};

export function bodyLimitFor(path: string): number {
  return BODY_LIMITS[path] ?? DEFAULT_MAX_BODY_BYTES;
}

export const payloadTooLarge = (): ApiError =>
  new ApiError(413, 'payload_too_large', 'Request body too large');

/** The exact request bytes (read once, capped). Signature checks hash these. */
export async function readRawBody(c: Ctx): Promise<Uint8Array> {
  const cached = c.get('rawBody');
  if (cached !== undefined) return cached;
  const limit = bodyLimitFor(c.req.path);
  const declared = c.req.header('content-length');
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > limit) {
    throw payloadTooLarge();
  }
  const body = c.req.raw.body;
  let bytes = new Uint8Array(0);
  if (body !== null) {
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) {
        await reader.cancel().catch(() => undefined);
        throw payloadTooLarge();
      }
      chunks.push(value);
    }
    bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  c.set('rawBody', bytes);
  return bytes;
}

export function validationError(details: ErrorDetail[]): ApiError {
  return new ApiError(422, 'validation_error', 'Request validation failed', {
    extra: { details },
  });
}

function issuesToDetails(where: string, issues: readonly z.core.$ZodIssue[]): ErrorDetail[] {
  return issues.map((issue) => ({
    loc: [where, ...issue.path.map((part) => String(part))],
    msg: issue.message,
  }));
}

/** Parse and validate a JSON body. Empty or non-JSON bodies are 422 like FastAPI. */
export async function parseJson<S extends z.ZodType>(c: Ctx, schema: S): Promise<z.output<S>> {
  const raw = await readRawBody(c);
  let value: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    if (text.trim() === '') {
      throw validationError([{ loc: ['body'], msg: 'Field required' }]);
    }
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw validationError([{ loc: ['body', '0'], msg: 'JSON decode error' }]);
  }
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(issuesToDetails('body', result.error.issues));
  return result.data;
}

/** Validate query parameters (single values; repeated keys take the last value like FastAPI). */
export function parseQuery<S extends z.ZodType>(c: Ctx, schema: S): z.output<S> {
  const url = new URL(c.req.url);
  const values: Record<string, string> = {};
  for (const [key, value] of url.searchParams) values[key] = value;
  const result = schema.safeParse(values);
  if (!result.success) throw validationError(issuesToDetails('query', result.error.issues));
  return result.data;
}

/** Validate one path parameter (e.g. a UUID); failures are 422 `path` errors like FastAPI. */
export function parsePath<S extends z.ZodType>(c: Ctx, name: string, schema: S): z.output<S> {
  const result = schema.safeParse(c.req.param(name));
  if (!result.success) {
    throw validationError(
      result.error.issues.map((issue) => ({ loc: ['path', name], msg: issue.message })),
    );
  }
  return result.data;
}
