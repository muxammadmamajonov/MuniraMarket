/**
 * Admin user management: list/search users, change a role or block a user (port of
 * services/api/app/repositories/admin_users.py). Phone numbers are never read here.
 *
 * Last-admin rule: the shop always keeps at least one active (non-blocked) admin. A change first
 * locks EVERY active admin row `FOR UPDATE` in id order, then the target, and only then counts,
 * so two admins demoting each other at the same moment serialise and the second is refused.
 *
 * Deviation (requested for the Function): blocking a user or changing their role also revokes
 * all of that user's sessions in the same transaction (`DELETE FROM auth_sessions WHERE user_id`,
 * as `PostgresSessionStore.revoke_user` does), instead of waiting for their next request.
 */

import { AuditEntity, recordAudit, type AuditActor } from '../audit.ts';
import type { Database } from '../db.ts';
import type { Language, UserRole } from '../http/context.ts';
import { isoSql } from '../http/serialize.ts';
import { escapeLike } from './adminCatalog.ts';

/** A `q` of only digits (and this long) is matched exactly against the Telegram id. */
export const MAX_TELEGRAM_ID_DIGITS = 19;

export class AdminUserError extends Error {}
export class UserNotFoundError extends AdminUserError {}
export class LastAdminError extends AdminUserError {}
export class CannotBlockSelfError extends AdminUserError {}
/** The acting admin was demoted or blocked by a concurrent request. */
export class ActorNotAdminError extends AdminUserError {}

export interface AdminUserRecord {
  id: string;
  telegram_user_id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  language: Language;
  role: UserRole;
  is_blocked: boolean;
  created_at: string;
}

const USER_COLUMNS = `
  u.id::text AS id, u.telegram_user_id, u.first_name, u.last_name, u.username,
  u.language::text AS language, u.role::text AS role, u.is_blocked,
  ${isoSql('u.created_at')} AS created_at`;

const isActiveAdmin = (role: UserRole, isBlocked: boolean): boolean =>
  role === 'admin' && !isBlocked;

export class AdminUserRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async listUsers(options: {
    query: string | null;
    role: UserRole | null;
    blocked: boolean | null;
    page: number;
    pageSize: number;
  }): Promise<{ items: AdminUserRecord[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (options.query) {
      params.push(`%${escapeLike(options.query)}%`);
      const n = params.length;
      let condition =
        `u.first_name ILIKE $${n} ESCAPE '\\' OR u.last_name ILIKE $${n} ESCAPE '\\' ` +
        `OR u.username ILIKE $${n} ESCAPE '\\'`;
      const q = options.query;
      if (/^[0-9]+$/.test(q) && q.length <= MAX_TELEGRAM_ID_DIGITS && BigInt(q) < 2n ** 63n) {
        params.push(BigInt(q).toString());
        condition += ` OR u.telegram_user_id = $${params.length}::bigint`;
      }
      conditions.push(`(${condition})`);
    }
    if (options.role !== null) {
      params.push(options.role);
      conditions.push(`u.role = $${params.length}`);
    }
    if (options.blocked !== null) {
      conditions.push(options.blocked ? 'u.is_blocked IS true' : 'u.is_blocked IS false');
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const count = await this.db.query<{ total: number }>(
      `SELECT count(*) AS total FROM users u ${where}`,
      params,
    );
    const total = count.rows[0]?.total ?? 0;
    const offset = (options.page - 1) * options.pageSize;
    if (offset >= total) return { items: [], total };
    const { rows } = await this.db.query<AdminUserRecord>(
      `SELECT ${USER_COLUMNS} FROM users u ${where}
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, options.pageSize, offset],
    );
    return { items: rows, total };
  }

  /** Throws `UserNotFoundError`, `CannotBlockSelfError`, `LastAdminError`, `ActorNotAdminError`. */
  async updateUser(
    userId: string,
    changes: { role: UserRole | null; isBlocked: boolean | null },
    actor: AuditActor,
  ): Promise<AdminUserRecord> {
    return this.db.tx(async (client) => {
      // Lock order: every active admin (id order), then the target.
      const admins = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM users WHERE role = 'admin' AND is_blocked IS false
         ORDER BY id FOR UPDATE`,
      );
      const activeAdmins = new Set(admins.rows.map((row) => row.id));
      const { rows } = await client.query<AdminUserRecord>(
        `SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1 FOR UPDATE`,
        [userId],
      );
      const user = rows[0];
      if (!user) throw new UserNotFoundError();
      const newRole = changes.role ?? user.role;
      const newBlocked = changes.isBlocked ?? user.is_blocked;
      if (newBlocked && !user.is_blocked && user.id === actor.userId)
        throw new CannotBlockSelfError();
      const removesAdmin =
        isActiveAdmin(user.role, user.is_blocked) && !isActiveAdmin(newRole, newBlocked);
      if (removesAdmin && [...activeAdmins].every((id) => id === user.id))
        throw new LastAdminError();
      if (actor.userId === null || !activeAdmins.has(actor.userId)) throw new ActorNotAdminError();

      let revoke = false;
      if (newRole !== user.role) {
        await recordAudit(client, actor, {
          action: 'user.role_change',
          entityType: AuditEntity.USER,
          entityId: user.id,
          changes: { role: [user.role, newRole] },
        });
        revoke = true;
      }
      if (newBlocked !== user.is_blocked) {
        await recordAudit(client, actor, {
          action: newBlocked ? 'user.block' : 'user.unblock',
          entityType: AuditEntity.USER,
          entityId: user.id,
          changes: { is_blocked: [user.is_blocked, newBlocked] },
        });
        if (newBlocked) revoke = true;
      }
      if (newRole !== user.role || newBlocked !== user.is_blocked) {
        await client.query(
          'UPDATE users SET role = $2, is_blocked = $3, updated_at = now() WHERE id = $1',
          [user.id, newRole, newBlocked],
        );
      }
      if (revoke) {
        // Same statement as PostgresSessionStore.revoke_user.
        await client.query('DELETE FROM auth_sessions WHERE user_id = $1', [user.id]);
      }
      const reloaded = await client.query<AdminUserRecord>(
        `SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`,
        [user.id],
      );
      return reloaded.rows[0] as AdminUserRecord;
    });
  }
}
