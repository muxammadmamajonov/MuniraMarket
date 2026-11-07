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
}

const COLUMNS = `id::text AS id, telegram_user_id, first_name, last_name, username,
  language::text AS language, role::text AS role, is_blocked`;

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
  };
}

/**
 * Insert or refresh the user in one atomic statement (committed on its own). The language is
 * taken from Telegram only when the user is first created, so a language picked inside the shop
 * is not overwritten on every sign-in.
 */
export async function upsertFromTelegram(
  db: SqlRunner,
  profile: TelegramProfile,
): Promise<UserRecord> {
  const language = languageFromCode(profile.languageCode) ?? 'uz';
  const { rows } = await db.query<UserRecord>(
    `INSERT INTO users (telegram_user_id, first_name, last_name, username, language)
     VALUES ($1, $2, $3, $4, $5::language)
     ON CONFLICT (telegram_user_id) DO UPDATE SET first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name, username = EXCLUDED.username, updated_at = now()
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
