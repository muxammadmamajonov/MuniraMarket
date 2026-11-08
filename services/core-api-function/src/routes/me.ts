/**
 * The signed-in user's own preferences (port of services/api/app/api/routes/me.py). Writes need
 * the session and the CSRF token; every response under `/me` is `Cache-Control: no-store`.
 */
import { ApiError } from '../errors.ts';
import { RULES, csrfProtectedUser, rateLimit } from '../http/auth.ts';
import { deps, type Ctx } from '../http/context.ts';
import { setLanguage, userPublic } from '../repositories/users.ts';
import { Validation, model, oneOf } from '../schemas/storefront/fields.ts';
import { readBody, readJsonBody } from '../schemas/storefront/http.ts';
import type { Router } from './index.ts';

const setLanguageRequest = model({ language: oneOf(['uz', 'ru'] as const) });

/** Save the storefront language: the same value the bot uses; the URL locale follows it. */
async function putLanguage(c: Ctx): Promise<Response> {
  const body = await readJsonBody(c);
  await rateLimit(c, RULES.PREFERENCES_WRITE, 'user');
  const user = await csrfProtectedUser(c);
  const validation = new Validation();
  const payload = readBody(validation, body, setLanguageRequest);
  validation.check();
  const updated = await setLanguage(deps(c).db, user.id, payload.language);
  if (updated === null) throw new ApiError(404, 'not_found', 'User not found');
  return c.json({ user: userPublic(updated) });
}

export function register(router: Router): void {
  router.put('/me/language', putLanguage);
}
