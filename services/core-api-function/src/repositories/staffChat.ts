import type { Database } from '../db.ts';

/**
 * The Telegram group that receives staff order alerts (port of
 * services/api/app/repositories/staff_chat.py, ADR 0015). Connecting is allowed only for a
 * non-blocked user whose role in THIS database is `admin`; the role is read and the row written
 * in one transaction with the user row locked, so a concurrent demotion cannot slip in between.
 */

export type ConnectOutcome = 'connected' | 'forbidden';
export const AUDIT_CONNECT = 'staff_chat.connect';

export async function connectStaffChat(
  db: Database,
  options: { telegramUserId: number; chatId: number },
): Promise<ConnectOutcome> {
  return db.tx(async (client) => {
    const { rows } = await client.query<{ id: string; role: string; is_blocked: boolean }>(
      `SELECT id::text AS id, role::text AS role, is_blocked FROM users
       WHERE telegram_user_id = $1 FOR UPDATE`,
      [options.telegramUserId],
    );
    const user = rows[0];
    if (user === undefined || user.is_blocked || user.role !== 'admin') return 'forbidden';
    await client.query(
      `INSERT INTO staff_notification_chat (id, chat_id, connected_by_user_id)
       VALUES (1, $1, $2::uuid)
       ON CONFLICT (id) DO UPDATE SET chat_id = EXCLUDED.chat_id,
         connected_by_user_id = EXCLUDED.connected_by_user_id,
         connected_at = EXCLUDED.connected_at`,
      [options.chatId, user.id],
    );
    // The chat id is operational configuration, but it is not needed in the log either: who
    // connected a group, and when, is what matters.
    await client.query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, entity_type, entity_id, details,
         created_at)
       VALUES ($1::uuid, 'admin', $2, 'staff_chat', '1', '{}'::jsonb, clock_timestamp())`,
      [user.id, AUDIT_CONNECT],
    );
    return 'connected';
  });
}
