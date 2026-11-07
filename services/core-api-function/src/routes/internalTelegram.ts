import { z } from 'zod';
import { ApiError } from '../errors.ts';
import { deps } from '../http/context.ts';
import { getUserByTelegramId, upsertFromTelegram, userPublic } from '../repositories/users.ts';
import { parseSignedJson, requireActor } from '../security/serviceAuth.ts';
import type { Router } from './index.ts';

/**
 * Internal routes for the Telegram Serverless bot (port of
 * services/api/app/api/routes/internal_telegram.py). Signed requests only (ADR 0003); bodies are
 * validated only after the signature check, so unauthenticated callers learn nothing.
 */

const TelegramSessionRequest = z.strictObject({
  telegram_user_id: z.number().int().gt(0),
  first_name: z.string().min(1).max(255),
  last_name: z.string().max(255).nullish(),
  username: z.string().max(64).nullish(),
  language_code: z.string().max(16).nullish(),
});

export function register(router: Router): void {
  /** Upsert the user the bot is acting for. The body id must equal the signed actor. */
  router.post('/internal/telegram/session', async (c) => {
    const actor = await requireActor(c);
    const payload = await parseSignedJson(c, TelegramSessionRequest);
    if (payload.telegram_user_id !== actor) {
      throw new ApiError(403, 'forbidden', 'Actor does not match request body');
    }
    const user = await upsertFromTelegram(deps(c).db, {
      telegramUserId: payload.telegram_user_id,
      firstName: payload.first_name,
      lastName: payload.last_name ?? null,
      username: payload.username ?? null,
      languageCode: payload.language_code ?? null,
    });
    if (user.is_blocked) throw new ApiError(403, 'forbidden', 'Account is blocked');
    return c.json({ user: userPublic(user) });
  });

  router.get('/internal/telegram/me', async (c) => {
    const actor = await requireActor(c);
    const user = await getUserByTelegramId(deps(c).db, actor);
    if (user === null || user.is_blocked) throw new ApiError(404, 'not_found', 'User not found');
    return c.json({ user: userPublic(user) });
  });
}
