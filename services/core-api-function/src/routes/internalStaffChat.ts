import { z } from 'zod';
import { ApiError } from '../errors.ts';
import { deps } from '../http/context.ts';
import { connectStaffChat } from '../repositories/staffChat.ts';
import { parseSignedJson, requireActor } from '../security/serviceAuth.ts';
import type { Router } from './index.ts';

/**
 * `/connect_orders` backend for the Telegram bot (port of
 * services/api/app/api/routes/internal_staff_chat.py, ADR 0015). The bot sends the group's chat
 * id with the sender as the signed actor; only an `admin` in the Core API may connect a group,
 * and the answer says nothing about who else is admin.
 */

const ConnectRequest = z.strictObject({
  // Telegram group and supergroup ids are negative; private chats (positive) are refused.
  chat_id: z
    .number()
    .int()
    .lt(0)
    .gte(-(10 ** 15)),
  chat_type: z.enum(['group', 'supergroup']),
});

export function register(router: Router): void {
  router.post('/internal/telegram/staff-chat/connect', async (c) => {
    const actor = await requireActor(c);
    const payload = await parseSignedJson(c, ConnectRequest);
    const outcome = await connectStaffChat(deps(c).db, {
      telegramUserId: actor,
      chatId: payload.chat_id,
    });
    if (outcome !== 'connected') throw new ApiError(403, 'forbidden', 'Admin role required');
    return c.json({ connected: true });
  });
}
