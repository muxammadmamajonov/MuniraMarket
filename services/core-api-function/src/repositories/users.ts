import type pg from 'pg';
import type { Language, UserRecord } from '../http/context.ts';

/** `Database` or a transaction's `PoolClient`. */
export interface SqlRunner {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

/**
 * User persistence (port of services/api/app/repositories/users.py) and the public user shape
 * (`UserPublic` in app/schemas/users.py: no phone, no internal flags).
 */

export interface TelegramProfile {
  telegramUserId: number;
  firstName: string;
  lastName?: string | null;
  username?: string | null;
  languageCode?: string | null;
}

export interface UserPublic {
  id: string;
  telegram_user_id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  language: Language;
  role: UserRecord['role'];
  language_confirmed: boolean;
  phone_verified: boolean;
  phone_hint: string | null;
  birth_date: string | null;
}

const COLUMNS = `id::text AS id, telegram_user_id, first_name, last_name, username,
  language::text AS language, role::text AS role, is_blocked,
  language_confirmed_at IS NOT NULL AS language_confirmed,
  phone_verified_at IS NOT NULL AS phone_verified, phone,
  to_char(birth_date, 'YYYY-MM-DD') AS birth_date`;

/** Only the last four digits stay readable; enough for the owner to recognise the number. */
export function phoneHint(phone: string | null | undefined): string | null {
  if (phone === null || phone === undefined) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return null;
  if (digits.startsWith('998') && digits.length === 12) {
    return `+998 •• ••• ${digits.slice(-4, -2)} ${digits.slice(-2)}`;
  }
  return `+${'•'.repeat(digits.length - 4)} ${digits.slice(-4)}`;
}

/** Map a Telegram `language_code` to a supported language, else `null`. */
export function languageFromCode(languageCode: string | null | undefined): Language | null {
  if (languageCode === null || languageCode === undefined) return null;
  const primary = languageCode.toLowerCase().split('-', 1)[0];
  return primary === 'uz' || primary === 'ru' ? primary : null;
}

export function userPublic(user: UserRecord): UserPublic {
  return {
    id: user.id,
    telegram_user_id: user.telegram_user_id,
    first_name: user.first_name,
    last_name: user.last_name,
    username: user.username,
    language: user.language,
    role: user.role,
    language_confirmed: user.language_confirmed,
    phone_verified: user.phone_verified,
    // Any stored number, verified or typed in the profile (`phone_verified` tells which).
    phone_hint: phoneHint(user.phone),
    birth_date: user.birth_date,
  };
}

/**
 * Insert or refresh the user in one atomic statement (committed on its own). The language is
 * taken from Telegram only when the user is first created, so a language picked inside the shop
 * is not overwritten on every sign-in. Likewise the name: once the user edited it in the shop
 * (`name_edited_at`), Telegram no longer overwrites `first_name` / `last_name`; `username` is
 * always refreshed.
 */
export async function upsertFromTelegram(
  db: SqlRunner,
  profile: TelegramProfile,
): Promise<UserRecord> {
  const language = languageFromCode(profile.languageCode) ?? 'uz';
  const { rows } = await db.query<UserRecord>(
    `INSERT INTO users (telegram_user_id, first_name, last_name, username, language)
     VALUES ($1, $2, $3, $4, $5::language)
     ON CONFLICT (telegram_user_id) DO UPDATE SET
       first_name = CASE WHEN users.name_edited_at IS NULL THEN EXCLUDED.first_name
                         ELSE users.first_name END,
       last_name = CASE WHEN users.name_edited_at IS NULL THEN EXCLUDED.last_name
                        ELSE users.last_name END,
       username = EXCLUDED.username, updated_at = now()
     RETURNING ${COLUMNS}`,
    [
      profile.telegramUserId,
      profile.firstName,
      profile.lastName ?? null,
      profile.username ?? null,
      language,
    ],
  );
  const user = rows[0];
  if (user === undefined) throw new Error('user upsert returned no row');
  return user;
}

export async function getUserByTelegramId(
  db: SqlRunner,
  telegramUserId: number,
): Promise<UserRecord | null> {
  const { rows } = await db.query<UserRecord>(
    `SELECT ${COLUMNS} FROM users WHERE telegram_user_id = $1`,
    [telegramUserId],
  );
  return rows[0] ?? null;
}

export async function getUserById(db: SqlRunner, userId: string): Promise<UserRecord | null> {
  const { rows } = await db.query<UserRecord>(`SELECT ${COLUMNS} FROM users WHERE id = $1::uuid`, [
    userId,
  ]);
  return rows[0] ?? null;
}

/**
 * The one write path for the language preference (bot onboarding and the shop profile). Marks
 * it confirmed so the bot does not ask again.
 */
export async function setLanguage(
  db: SqlRunner,
  userId: string,
  language: Language,
): Promise<UserRecord | null> {
  const { rows } = await db.query<UserRecord>(
    `UPDATE users SET language = $2::language, language_confirmed_at = now(), updated_at = now()
     WHERE id = $1::uuid RETURNING ${COLUMNS}`,
    [userId, language],
  );
  return rows[0] ?? null;
}

const PHONE_ALLOWED = /^[0-9+\s()-]+$/;

/** E.164 `+<digits>` from a Telegram contact number (`998901234567`, `+998 90 ...`), else null. */
export function normalizeContactPhone(raw: string): string | null {
  const stripped = raw.trim();
  if (stripped === '' || !PHONE_ALLOWED.test(stripped) || stripped.slice(1).includes('+')) {
    return null;
  }
  const digits = stripped.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15 || digits.startsWith('0')) return null;
  return `+${digits}`;
}

/** Store the user's OWN Telegram contact number as their verified account phone. */
export async function recordTelegramPhone(
  db: SqlRunner,
  telegramUserId: number,
  phone: string,
): Promise<UserRecord | null> {
  const { rows } = await db.query<UserRecord>(
    `UPDATE users SET phone = $2, phone_verified_at = now(),
       phone_verification_method = 'telegram_contact', updated_at = now()
     WHERE telegram_user_id = $1 RETURNING ${COLUMNS}`,
    [telegramUserId, phone],
  );
  return rows[0] ?? null;
}

/** `PATCH /me`: only the keys the request contained (`undefined` = not sent). */
export interface ProfileUpdate {
  first_name?: string;
  last_name?: string | null;
  /** `YYYY-MM-DD`, or null to clear. */
  birth_date?: string | null;
  /** Normalised `+998XXXXXXXXX`, or null to remove the phone (and its verification). */
  phone?: string | null;
}

/**
 * Apply `PATCH /me` in one atomic UPDATE (port of `update_profile`). Writing either name part
 * marks the name as user-edited. A phone equal to the stored one changes nothing (its
 * verification is kept); a different number is stored unverified; null removes the phone and
 * its verification. Every `CASE` reads the row as it was before this statement.
 */
export async function updateProfile(
  db: SqlRunner,
  userId: string,
  changes: ProfileUpdate,
): Promise<UserRecord | null> {
  const params: unknown[] = [userId];
  const sets = ['updated_at = now()'];
  const param = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (changes.first_name !== undefined) sets.push(`first_name = ${param(changes.first_name)}`);
  if (changes.last_name !== undefined) sets.push(`last_name = ${param(changes.last_name)}`);
  if (changes.first_name !== undefined || changes.last_name !== undefined) {
    sets.push('name_edited_at = now()');
  }
  if (changes.birth_date !== undefined) {
    sets.push(`birth_date = ${param(changes.birth_date)}::date`);
  }
  if (changes.phone === null) {
    sets.push('phone = NULL', 'phone_verified_at = NULL', 'phone_verification_method = NULL');
  } else if (changes.phone !== undefined) {
    // One explicit type for the parameter (it is both assigned and compared).
    const phone = `${param(changes.phone)}::text`;
    sets.push(
      `phone = ${phone}`,
      `phone_verified_at = CASE WHEN phone = ${phone} THEN phone_verified_at END`,
      `phone_verification_method = CASE WHEN phone = ${phone} THEN phone_verification_method END`,
    );
  }
  const { rows } = await db.query<UserRecord>(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $1::uuid RETURNING ${COLUMNS}`,
    params,
  );
  return rows[0] ?? null;
}
