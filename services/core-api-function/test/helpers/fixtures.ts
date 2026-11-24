import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../../src/db.ts';
import type {
  Language,
  UserRecord,
  UserRole,
  SessionEntrance,
  AuthMethod,
} from '../../src/http/context.ts';
import { ADMIN_ORIGIN, WEB_ORIGIN } from './harness.ts';

/**
 * Integration fixtures that write the same rows the FastAPI reference writes, so storefront and
 * admin tests do not depend on the sign-in routes: a user, and a live `auth_sessions` row keyed
 * by sha256(token) with the reference's JSON record (services/api/app/security/session.py).
 */

let nextTelegramId = 7_000_000_000;

export async function createUser(
  db: Database,
  overrides: Partial<
    Pick<UserRecord, 'first_name' | 'role' | 'is_blocked' | 'telegram_user_id'>
  > & {
    language?: Language;
  } = {},
): Promise<UserRecord> {
  const telegramUserId = overrides.telegram_user_id ?? nextTelegramId++;
  const { rows } = await db.query<UserRecord>(
    `INSERT INTO users (id, telegram_user_id, first_name, language, role, is_blocked)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
     RETURNING id::text, telegram_user_id, first_name, last_name, username, language::text AS language,
               role::text AS role, is_blocked`,
    [
      telegramUserId,
      overrides.first_name ?? 'Test',
      overrides.language ?? 'uz',
      overrides.role ?? ('customer' satisfies UserRole),
      overrides.is_blocked ?? false,
    ],
  );
  const user = rows[0];
  if (!user) throw new Error('user not created');
  return user;
}

export interface TestSession {
  token: string;
  csrfToken: string;
  /** `Cookie` header value (non-secure cookie name, as in APP_ENV=test). */
  cookie: string;
  /** Headers for a CSRF-protected write from the matching browser origin. */
  writeHeaders: Record<string, string>;
}

export async function createSession(
  db: Database,
  user: Pick<UserRecord, 'id' | 'telegram_user_id'>,
  options: { entrance?: SessionEntrance; authMethod?: AuthMethod; ttlSeconds?: number } = {},
): Promise<TestSession> {
  const entrance = options.entrance ?? 'storefront';
  const authMethod =
    options.authMethod ?? (entrance === 'admin' ? 'telegram_oidc' : 'telegram_init_data');
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const record = {
    user_id: user.id,
    telegram_user_id: user.telegram_user_id,
    csrf_token: csrfToken,
    auth_method: authMethod,
    created_at: now,
    last_rotated_at: now,
    entrance,
  };
  await db.query(
    `INSERT INTO auth_sessions (token_hash, record, user_id, expires_at)
     VALUES ($1, $2::jsonb, $3, now() + make_interval(secs => $4))`,
    [
      createHash('sha256').update(token, 'ascii').digest('hex'),
      JSON.stringify(record),
      user.id,
      options.ttlSeconds ?? 3600,
    ],
  );
  return {
    token,
    csrfToken,
    cookie: `mm_session=${token}`,
    writeHeaders: {
      origin: entrance === 'admin' ? ADMIN_ORIGIN : WEB_ORIGIN,
      'x-csrf-token': csrfToken,
    },
  };
}

/** A staff user with an admin-origin OIDC session (what every /admin route requires). */
export async function createStaff(db: Database, role: Extract<UserRole, 'operator' | 'admin'>) {
  const user = await createUser(db, { role });
  const session = await createSession(db, user, { entrance: 'admin' });
  return { user, session };
}
