import { createHmac } from 'node:crypto';
import type { z } from 'zod';
import type { Database } from '../db.ts';
import { ApiError, StoreUnavailableError, type ErrorDetail } from '../errors.ts';
import { readRawBody, validationError } from '../http/body.ts';
import { deps, type Clock, type Ctx, type ServiceContext } from '../http/context.ts';
import { constantTimeEqual, sha256Hex } from './tokens.ts';

/**
 * Service-to-service request signing (ADR 0003, `MM-SVC-V1`; port of
 * services/api/app/security/service_auth.py).
 *
 * The caller signs an 8-line canonical string (version, key id, timestamp, nonce, method, path
 * with query exactly as sent, actor, sha256 of the exact body bytes) with HMAC-SHA256. Checks run
 * cheapest first: header shapes, known key and timestamp skew before the body is read; then the
 * signature (constant time) over the raw bytes from `readRawBody`; then the nonce, which is only
 * recorded for a valid signature. Every failure is the same generic 401; the reason is logged.
 */

export const VERSION = 'MM-SVC-V1';
export const MAX_SKEW_SECONDS = 300;
/** Must outlive the accepted timestamp window on both sides (2 x 300 s) plus a margin. */
export const NONCE_TTL_SECONDS = 660;

const KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const TIMESTAMP_RE = /^[0-9]{1,12}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const ACTOR_RE = /^tg:([1-9][0-9]{0,17})$/;
const SIGNATURE_RE = /^[0-9a-f]{64}$/;

/** Internal-only; `reason` is logged but never returned to the client. */
export class ServiceAuthError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'ServiceAuthError';
    this.reason = reason;
  }
}

export function canonicalString(input: {
  keyId: string;
  timestamp: string;
  nonce: string;
  method: string;
  path: string;
  actor: string;
  body: Uint8Array;
}): string {
  return [
    VERSION,
    input.keyId,
    input.timestamp,
    input.nonce,
    input.method.toUpperCase(),
    input.path,
    input.actor,
    sha256Hex(input.body),
  ].join('\n');
}

/** Lowercase-hex HMAC-SHA256 signature (tests and reference tooling). */
export function sign(input: Parameters<typeof canonicalString>[0] & { secret: string }): string {
  return createHmac('sha256', Buffer.from(input.secret, 'utf8'))
    .update(canonicalString(input), 'utf8')
    .digest('hex');
}

interface PendingServiceRequest {
  keyId: string;
  secret: string;
  timestamp: string;
  nonce: string;
  actor: string;
  signature: string;
}

/** Cheap checks that need no body: header shapes, known key, timestamp skew. */
export function precheck(
  headers: Headers,
  keys: ReadonlyMap<string, string>,
  now: number,
): PendingServiceRequest {
  const keyId = headers.get('x-mm-key-id') ?? '';
  const timestamp = headers.get('x-mm-timestamp') ?? '';
  const nonce = headers.get('x-mm-nonce') ?? '';
  const actor = headers.get('x-mm-actor') ?? '';
  const signature = headers.get('x-mm-signature') ?? '';
  if (
    !KEY_ID_RE.test(keyId) ||
    !TIMESTAMP_RE.test(timestamp) ||
    !NONCE_RE.test(nonce) ||
    !SIGNATURE_RE.test(signature)
  ) {
    throw new ServiceAuthError('malformed_headers');
  }
  if (actor !== '' && !ACTOR_RE.test(actor)) throw new ServiceAuthError('malformed_actor');
  const secret = keys.get(keyId);
  if (secret === undefined) throw new ServiceAuthError('unknown_key');
  if (Math.abs(now - Number(timestamp)) > MAX_SKEW_SECONDS) {
    throw new ServiceAuthError('timestamp_skew');
  }
  return { keyId, secret, timestamp, nonce, actor, signature };
}

/**
 * Replay store shared by every instance (`service_request_nonces`): the upsert returns a row only
 * when the nonce is new or its previous use expired, in one statement, so two concurrent requests
 * with the same nonce cannot both win.
 */
export async function registerNonce(
  db: Database,
  clock: Clock,
  keyId: string,
  nonce: string,
  ttlSeconds: number,
): Promise<boolean> {
  const now = clock();
  return db.storeTx(async (client) => {
    const result = await client.query(
      `INSERT INTO service_request_nonces (key_id, nonce, expires_at)
       VALUES ($1, $2, to_timestamp($3::float8))
       ON CONFLICT (key_id, nonce) DO UPDATE SET expires_at = EXCLUDED.expires_at
         WHERE service_request_nonces.expires_at <= to_timestamp($4::float8)
       RETURNING nonce`,
      [keyId, nonce, now + ttlSeconds, now],
    );
    return (result.rowCount ?? 0) > 0;
  });
}

/** Path plus query string exactly as sent on the wire (before percent-decoding). */
export function pathWithQuery(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

async function authenticate(c: Ctx): Promise<ServiceContext> {
  const { settings, db, clock, logger } = deps(c);
  try {
    const pending = precheck(c.req.raw.headers, settings.serviceAuthKeys, clock());
    const body = await readRawBody(c);
    const expected = sign({
      secret: pending.secret,
      keyId: pending.keyId,
      timestamp: pending.timestamp,
      nonce: pending.nonce,
      method: c.req.method,
      path: pathWithQuery(c.req.url),
      actor: pending.actor,
      body,
    });
    if (!constantTimeEqual(expected, pending.signature))
      throw new ServiceAuthError('bad_signature');
    // Replay protection - only reached with a valid signature.
    if (!(await registerNonce(db, clock, pending.keyId, pending.nonce, NONCE_TTL_SECONDS))) {
      throw new ServiceAuthError('replayed_nonce');
    }
    return {
      keyId: pending.keyId,
      actorTelegramUserId: pending.actor === '' ? null : Number(pending.actor.slice(3)),
    };
  } catch (error) {
    if (error instanceof ServiceAuthError) {
      logger.warning('Service request rejected', { reason: error.reason });
    } else if (error instanceof StoreUnavailableError) {
      // Only reachable after a valid signature, so this reveals nothing to an attacker.
      logger.error('Replay store unavailable; failing closed');
      throw new ApiError(503, 'service_unavailable', 'Service unavailable');
    } else {
      throw error;
    }
  }
  throw new ApiError(401, 'unauthorized', 'Unauthorized');
}

// One verification per request: the nonce may only be registered once (FastAPI caches the
// dependency per request the same way).
const verified = new WeakMap<Request, Promise<ServiceContext>>();

/** Authenticate a signed internal request or raise a generic 401 (503 if the store is down). */
export function requireServiceRequest(c: Ctx): Promise<ServiceContext> {
  const existing = verified.get(c.req.raw);
  if (existing !== undefined) return existing;
  const promise = authenticate(c);
  promise.catch(() => undefined);
  verified.set(c.req.raw, promise);
  return promise;
}

/** Signed request acting for a Telegram user; returns that user's id (403 without an actor). */
export async function requireActor(c: Ctx): Promise<number> {
  const context = await requireServiceRequest(c);
  if (context.actorTelegramUserId === null) {
    throw new ApiError(403, 'forbidden', 'Actor required');
  }
  return context.actorTelegramUserId;
}

/** Signed request acting for the service itself (empty actor); 403 when a user is named. */
export async function requireServiceWithoutActor(c: Ctx): Promise<ServiceContext> {
  const context = await requireServiceRequest(c);
  if (context.actorTelegramUserId !== null) {
    throw new ApiError(403, 'forbidden', 'Service requests only');
  }
  return context;
}

// --- signed bodies --------------------------------------------------------------------------------

function pydanticMessage(issue: z.core.$ZodIssue): string {
  if (issue.code === 'invalid_type' && issue.input === undefined) return 'Field required';
  return issue.message;
}

/**
 * Validate a signed route's JSON body AFTER the signature check (the reference parses these by
 * hand with `model_validate_json`, so error locations carry no `body` prefix). `emptyAs` is what
 * an empty body means (`{}` for the claim route); otherwise an empty body is invalid JSON.
 */
export async function parseSignedJson<S extends z.ZodType>(
  c: Ctx,
  schema: S,
  options: { emptyAs?: unknown } = {},
): Promise<z.output<S>> {
  const raw = await readRawBody(c);
  let value: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    if (text === '' && options.emptyAs !== undefined) value = options.emptyAs;
    else value = JSON.parse(text);
  } catch {
    throw validationError([{ loc: [], msg: 'Invalid JSON' }]);
  }
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const details: ErrorDetail[] = [];
  for (const issue of result.error.issues) {
    const path = issue.path.map((part) => String(part));
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        details.push({ loc: [...path, key], msg: 'Extra inputs are not permitted' });
      }
      continue;
    }
    details.push({ loc: path, msg: pydanticMessage(issue) });
  }
  throw validationError(details);
}
