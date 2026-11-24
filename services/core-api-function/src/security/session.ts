import type { Database } from '../db.ts';
import type { AuthMethod, Clock, SessionData, SessionEntrance } from '../http/context.ts';
import type { Logger } from '../logging.ts';
import { sha256Hex, tokenUrlsafe } from './tokens.ts';

/**
 * Server-side browser sessions (port of services/api/app/security/session.py, ADR 0007/0013).
 *
 * The browser holds an opaque random token in an HTTP-only cookie; only `sha256(token)` is
 * stored (`auth_sessions.token_hash`). Rotation leaves a short-lived tombstone
 * `{"rotated_to": "<new hash>"}` under the old key so parallel requests sent with the old cookie
 * still resolve during `SESSION_ROTATION_GRACE_SECONDS`. Every store operation is its own short
 * transaction (`db.storeTx`), failing closed with `StoreUnavailableError`.
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

export class SessionGoneError extends Error {
  constructor() {
    super('session gone');
    this.name = 'SessionGoneError';
  }
}

export enum SwapResult {
  GONE = 0,
  SWAPPED = 1,
  ALREADY_ROTATED = 2,
}

export type StoredRecord =
  { kind: 'session'; data: SessionData } | { kind: 'tombstone'; rotatedTo: string };

export const newToken = (): string => tokenUrlsafe(32);
export const hashToken = (token: string): string => sha256Hex(token);
export const isWellFormedToken = (token: string): boolean => TOKEN_RE.test(token);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `SessionData.to_json` field order (the stored JSON record). */
export function sessionRecord(data: SessionData): Record<string, unknown> {
  return {
    user_id: data.user_id,
    telegram_user_id: data.telegram_user_id,
    csrf_token: data.csrf_token,
    auth_method: data.auth_method,
    created_at: data.created_at,
    last_rotated_at: data.last_rotated_at,
    entrance: data.entrance,
  };
}

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

function canonicalUuid(value: string): string {
  const hex = value.replaceAll('-', '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Parse a stored record; throws on anything unexpected (`SessionData.from_json`). */
export function parseSessionData(payload: unknown): SessionData {
  if (!isPlainObject(payload)) throw new Error('session record is not an object');
  const authMethod = payload['auth_method'];
  if (authMethod !== 'telegram_init_data' && authMethod !== 'telegram_oidc') {
    throw new Error('unknown auth method');
  }
  const entrance = payload['entrance'];
  if (entrance !== 'storefront' && entrance !== 'admin') throw new Error('unknown entrance');
  const ints = ['telegram_user_id', 'created_at', 'last_rotated_at'].map((k) => payload[k]);
  if (ints.some((v) => typeof v !== 'number' || !Number.isSafeInteger(v))) {
    throw new Error('session record has invalid integers');
  }
  const csrf = payload['csrf_token'];
  if (typeof csrf !== 'string' || csrf === '') throw new Error('session record has no csrf token');
  const userId = String(payload['user_id']);
  if (!UUID_RE.test(userId)) throw new Error('invalid user id');
  return {
    user_id: canonicalUuid(userId),
    telegram_user_id: payload['telegram_user_id'] as number,
    csrf_token: csrf,
    auth_method: authMethod as AuthMethod,
    created_at: payload['created_at'] as number,
    last_rotated_at: payload['last_rotated_at'] as number,
    entrance: entrance as SessionEntrance,
  };
}

export function decodeRecord(raw: unknown): StoredRecord | null {
  if (raw === null || raw === undefined) return null;
  try {
    if (isPlainObject(raw) && Object.keys(raw).length === 1 && 'rotated_to' in raw) {
      const rotatedTo = raw['rotated_to'];
      if (typeof rotatedTo !== 'string' || !HASH_RE.test(rotatedTo)) {
        throw new Error('malformed tombstone');
      }
      return { kind: 'tombstone', rotatedTo };
    }
    return { kind: 'session', data: parseSessionData(raw) };
  } catch {
    return null;
  }
}

/** `auth_sessions` rows keyed by `sha256(token)` hex; rows past `expires_at` are invisible. */
export class PostgresSessionStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async get(tokenHash: string): Promise<StoredRecord | null> {
    const now = this.clock();
    const raw = await this.db.storeTx(async (client) => {
      const { rows } = await client.query<{ record: unknown }>(
        'SELECT record FROM auth_sessions WHERE token_hash = $1 AND expires_at > to_timestamp($2::float8)',
        [tokenHash, now],
      );
      return rows[0]?.record ?? null;
    });
    if (raw === null) return null;
    const record = decodeRecord(raw);
    if (record === null) {
      this.logger.warning('Discarding malformed session record');
      await this.delete(tokenHash);
    }
    return record;
  }

  async set(tokenHash: string, data: SessionData, ttlSeconds: number): Promise<void> {
    const expires = this.clock() + ttlSeconds;
    await this.db.storeTx(async (client) => {
      await client.query(
        `INSERT INTO auth_sessions (token_hash, record, user_id, expires_at)
         VALUES ($1, $2::jsonb, $3::uuid, to_timestamp($4::float8))
         ON CONFLICT (token_hash) DO UPDATE SET record = EXCLUDED.record,
           user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at`,
        [tokenHash, JSON.stringify(sessionRecord(data)), data.user_id, expires],
      );
    });
  }

  /** Reset the TTL of an unexpired record; never revives one. `false` if it is gone. */
  async expire(tokenHash: string, ttlSeconds: number): Promise<boolean> {
    const now = this.clock();
    return this.db.storeTx(async (client) => {
      const result = await client.query(
        `UPDATE auth_sessions SET expires_at = to_timestamp($3::float8)
         WHERE token_hash = $1 AND expires_at > to_timestamp($2::float8) RETURNING token_hash`,
        [tokenHash, now, now + ttlSeconds],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async delete(...tokenHashes: string[]): Promise<void> {
    if (tokenHashes.length === 0) return;
    await this.db.storeTx(async (client) => {
      await client.query('DELETE FROM auth_sessions WHERE token_hash = ANY($1::text[])', [
        tokenHashes,
      ]);
    });
  }

  /**
   * One transaction holding the old row's lock (`SELECT ... FOR UPDATE`): a parallel rotation
   * that won is seen as `ALREADY_ROTATED`, a concurrent logout/block as `GONE`; nothing is
   * written in either case.
   */
  async replace(
    oldHash: string,
    newHash: string,
    data: SessionData,
    ttlSeconds: number,
    graceSeconds: number,
  ): Promise<SwapResult> {
    const now = this.clock();
    return this.db.storeTx(async (client) => {
      const { rows } = await client.query<{ record: unknown }>(
        `SELECT record FROM auth_sessions
         WHERE token_hash = $1 AND expires_at > to_timestamp($2::float8) FOR UPDATE`,
        [oldHash, now],
      );
      const current = rows[0];
      if (current === undefined) return SwapResult.GONE;
      if (isPlainObject(current.record) && 'rotated_to' in current.record) {
        return SwapResult.ALREADY_ROTATED;
      }
      await client.query(
        `INSERT INTO auth_sessions (token_hash, record, user_id, expires_at)
         VALUES ($1, $2::jsonb, $3::uuid, to_timestamp($4::float8))`,
        [newHash, JSON.stringify(sessionRecord(data)), data.user_id, now + ttlSeconds],
      );
      if (graceSeconds > 0) {
        await client.query(
          `UPDATE auth_sessions SET record = $2::jsonb, user_id = NULL,
             expires_at = to_timestamp($3::float8) WHERE token_hash = $1`,
          [oldHash, JSON.stringify({ rotated_to: newHash }), now + graceSeconds],
        );
      } else {
        await client.query('DELETE FROM auth_sessions WHERE token_hash = $1', [oldHash]);
      }
      return SwapResult.SWAPPED;
    });
  }

  /** Delete every live session of `userId` (their tombstones then resolve to nothing). */
  async revokeUser(userId: string): Promise<void> {
    await this.db.storeTx(async (client) => {
      await client.query('DELETE FROM auth_sessions WHERE user_id = $1::uuid', [userId]);
    });
  }
}

/** A freshly minted (login) or rotated session. `token` goes into the cookie only. */
export interface IssuedSession {
  token: string;
  data: SessionData;
  maxAgeSeconds: number;
}

export interface LoadedSession {
  token: string;
  data: SessionData;
  absoluteRemainingSeconds: number;
  /** Resolved through a rotation tombstone: served, but never rotated again, no cookie. */
  viaTombstone: boolean;
}

interface Resolved {
  data: SessionData;
  liveHash: string;
  hashes: string[];
}

export interface SessionPolicy {
  idleTtlSeconds: number;
  absoluteTtlSeconds: number;
  rotateAfterSeconds: number;
  rotationGraceSeconds: number;
}

/** Session policy: sliding idle TTL, absolute lifetime, rotation and revocation. */
export class SessionManager {
  constructor(
    private readonly store: PostgresSessionStore,
    private readonly clock: Clock,
    private readonly policy: SessionPolicy,
  ) {}

  private now(): number {
    return Math.trunc(this.clock());
  }

  /** Mint a new session; the session presented with the login request is destroyed first. */
  async create(options: {
    userId: string;
    telegramUserId: number;
    authMethod: AuthMethod;
    entrance: SessionEntrance;
    previousToken: string | null;
  }): Promise<IssuedSession> {
    if (options.previousToken !== null) await this.revoke(options.previousToken);
    const now = this.now();
    const data: SessionData = {
      user_id: options.userId,
      telegram_user_id: options.telegramUserId,
      csrf_token: tokenUrlsafe(32),
      auth_method: options.authMethod,
      created_at: now,
      last_rotated_at: now,
      entrance: options.entrance,
    };
    const token = newToken();
    const { idleTtlSeconds, absoluteTtlSeconds } = this.policy;
    await this.store.set(hashToken(token), data, Math.min(idleTtlSeconds, absoluteTtlSeconds));
    return { token, data, maxAgeSeconds: absoluteTtlSeconds };
  }

  /** The live record for `token`, following at most ONE tombstone (never a chain). */
  private async resolve(token: string): Promise<Resolved | null> {
    if (!isWellFormedToken(token)) return null;
    const tokenHash = hashToken(token);
    const record = await this.store.get(tokenHash);
    if (record === null) return null;
    if (record.kind === 'tombstone') {
      const successor = await this.store.get(record.rotatedTo);
      if (successor === null || successor.kind !== 'session') return null;
      return {
        data: successor.data,
        liveHash: record.rotatedTo,
        hashes: [tokenHash, record.rotatedTo],
      };
    }
    return { data: record.data, liveHash: tokenHash, hashes: [tokenHash] };
  }

  /** Look the session up and slide its idle expiry. `null` if unknown or expired. */
  async load(token: string): Promise<LoadedSession | null> {
    const resolved = await this.resolve(token);
    if (resolved === null) return null;
    const remaining = resolved.data.created_at + this.policy.absoluteTtlSeconds - this.now();
    if (remaining <= 0) {
      await this.store.delete(...resolved.hashes);
      return null;
    }
    const ttl = Math.min(this.policy.idleTtlSeconds, remaining);
    if (!(await this.store.expire(resolved.liveHash, ttl))) return null; // deleted concurrently
    return {
      token,
      data: resolved.data,
      absoluteRemainingSeconds: remaining,
      viaTombstone: resolved.hashes.length > 1,
    };
  }

  /** Look the session up without sliding its expiry (logout). */
  async peek(token: string): Promise<SessionData | null> {
    return (await this.resolve(token))?.data ?? null;
  }

  /**
   * Swap the token once `rotateAfter` has passed (the CSRF token is kept). `null` when not due,
   * when `loaded` came through a tombstone, or when a parallel request rotated first. Throws
   * `SessionGoneError` when the session was deleted since it was loaded.
   */
  async rotateIfDue(loaded: LoadedSession): Promise<IssuedSession | null> {
    if (loaded.viaTombstone) return null;
    const now = this.now();
    if (now - loaded.data.last_rotated_at < this.policy.rotateAfterSeconds) return null;
    const data: SessionData = { ...loaded.data, last_rotated_at: now };
    const token = newToken();
    const remaining = loaded.absoluteRemainingSeconds;
    const result = await this.store.replace(
      hashToken(loaded.token),
      hashToken(token),
      data,
      Math.min(this.policy.idleTtlSeconds, remaining),
      Math.min(this.policy.rotationGraceSeconds, remaining),
    );
    if (result === SwapResult.GONE) throw new SessionGoneError();
    if (result === SwapResult.ALREADY_ROTATED) return null;
    return { token, data, maxAgeSeconds: remaining };
  }

  /** Delete the session `token` belongs to; a tombstone takes its live successor down too. */
  async revoke(token: string): Promise<void> {
    if (!isWellFormedToken(token)) return;
    const tokenHash = hashToken(token);
    const record = await this.store.get(tokenHash);
    if (record !== null && record.kind === 'tombstone') {
      await this.store.delete(tokenHash, record.rotatedTo);
    } else {
      await this.store.delete(tokenHash);
    }
  }

  async revokeUser(userId: string): Promise<void> {
    await this.store.revokeUser(userId);
  }
}
