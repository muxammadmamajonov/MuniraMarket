/**
 * Audit log reads (admin only; port of services/api/app/repositories/audit.py). Writes go through
 * `recordAudit` (src/audit.ts) exclusively.
 */

import type { Database } from '../db.ts';
import type { UserRole } from '../http/context.ts';
import { isoSql } from '../http/serialize.ts';

export interface AuditEntryRecord {
  id: string;
  created_at: string;
  actor_user_id: string | null;
  actor_role: UserRole;
  action: string;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown>;
}

export interface AuditFilter {
  entityType: string | null;
  entityId: string | null;
  action: string | null;
  actorUserId: string | null;
}

export class AuditRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async listEntries(
    filters: AuditFilter,
    page: number,
    pageSize: number,
  ): Promise<{ items: AuditEntryRecord[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      conditions.push(`${sql} = $${params.length}`);
    };
    if (filters.entityType !== null) add('a.entity_type', filters.entityType);
    if (filters.entityId !== null) add('a.entity_id', filters.entityId);
    if (filters.action !== null) add('a.action', filters.action);
    if (filters.actorUserId !== null) add('a.actor_user_id', filters.actorUserId);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const count = await this.db.query<{ total: number }>(
      `SELECT count(*) AS total FROM audit_log a ${where}`,
      params,
    );
    const total = count.rows[0]?.total ?? 0;
    const offset = (page - 1) * pageSize;
    if (offset >= total) return { items: [], total };
    const { rows } = await this.db.query<AuditEntryRecord>(
      `SELECT a.id::text AS id, ${isoSql('a.created_at')} AS created_at,
              a.actor_user_id::text AS actor_user_id, a.actor_role::text AS actor_role, a.action,
              a.entity_type, a.entity_id, a.details
       FROM audit_log a ${where}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    );
    return { items: rows, total };
  }
}
