/**
 * The signed-in user's own profile, preferences and saved delivery addresses (port of
 * services/api/app/api/routes/me.py). Writes need the session and the CSRF token and are limited
 * per user (`preferences_write`); every response under `/me` is `Cache-Control: no-store`.
 * Addresses are looked up by id AND the signed-in user, so another user's address is
 * indistinguishable from a missing one (404). Request bodies are never logged.
 */
import { ApiError } from '../errors.ts';
import { RULES, csrfProtectedUser, currentUser, rateLimit } from '../http/auth.ts';
import { deps, type Ctx } from '../http/context.ts';
import {
  AddressLimitReachedError,
  createAddress,
  deleteAddress,
  listAddresses,
  replaceAddress,
  type AddressInput,
} from '../repositories/addresses.ts';
import { setLanguage, updateProfile, userPublic } from '../repositories/users.ts';
import { INVALID, Validation, model, oneOf, uuid } from '../schemas/storefront/fields.ts';
import { readBody, readJsonBody, readPath } from '../schemas/storefront/http.ts';
import {
  AT_LEAST_ONE_FIELD,
  savedAddressRequest,
  updateProfileRequest,
  type SavedAddressRequest,
} from '../schemas/storefront/requests.ts';
import { savedAddress } from '../schemas/storefront/responses.ts';
import { noContent } from './adminCommon.ts';
import type { Router } from './index.ts';

const setLanguageRequest = model({ language: oneOf(['uz', 'ru'] as const) });
const addressIdParam = uuid();

const addressNotFound = (): ApiError => new ApiError(404, 'address_not_found', 'Address not found');

/**
 * Edit the profile: name, birth date and phone; only the keys sent change. Editing the name stops
 * Telegram sign-ins from overwriting it. A phone different from the stored number is saved
 * UNVERIFIED; the same number keeps its verification; null removes the phone.
 */
async function patchMe(c: Ctx): Promise<Response> {
  const body = await readJsonBody(c);
  await rateLimit(c, RULES.PREFERENCES_WRITE, 'user');
  const user = await csrfProtectedUser(c);
  const validation = new Validation();
  const payload = readBody(validation, body, updateProfileRequest);
  if (
    (payload as unknown) !== INVALID &&
    Object.values(payload).every((value) => value === undefined)
  ) {
    validation.issues.push({ loc: ['body'], msg: AT_LEAST_ONE_FIELD });
  }
  validation.check();
  const updated = await updateProfile(deps(c).db, user.id, {
    ...(payload.first_name !== undefined && { first_name: payload.first_name }),
    ...(payload.last_name !== undefined && { last_name: payload.last_name }),
    ...(payload.birth_date !== undefined && { birth_date: payload.birth_date }),
    ...(payload.phone !== undefined && { phone: payload.phone }),
  });
  if (updated === null) throw new ApiError(404, 'not_found', 'User not found');
  return c.json({ user: userPublic(updated) });
}

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

// --- saved addresses -----------------------------------------------------------------------------

function addressInput(payload: SavedAddressRequest): AddressInput {
  return {
    label: payload.label,
    lat: payload.lat,
    lon: payload.lon,
    street: payload.street,
    house: payload.house,
    apartment: payload.apartment,
    entrance: payload.entrance,
    floor: payload.floor,
    landmark: payload.landmark,
  };
}

/** The saved addresses: the default first, then the most recently updated. */
async function getAddresses(c: Ctx): Promise<Response> {
  const user = await currentUser(c);
  const records = await listAddresses(deps(c).db.pool, user.id);
  return c.json({ items: records.map(savedAddress) });
}

/**
 * Save an address (at most 10: `409 address_limit_reached`). The first one becomes the default;
 * `is_default: true` moves the default to the new address.
 */
async function postAddress(c: Ctx): Promise<Response> {
  const body = await readJsonBody(c);
  await rateLimit(c, RULES.PREFERENCES_WRITE, 'user');
  const user = await csrfProtectedUser(c);
  const validation = new Validation();
  const payload = readBody(validation, body, savedAddressRequest);
  validation.check();
  try {
    const record = await createAddress(
      deps(c).db,
      user.id,
      addressInput(payload),
      payload.is_default ?? null,
    );
    return c.json(savedAddress(record), 201);
  } catch (error) {
    if (error instanceof AddressLimitReachedError) {
      throw new ApiError(409, 'address_limit_reached', 'Too many saved addresses');
    }
    throw error;
  }
}

/**
 * Replace every field of one of the user's addresses. `is_default: true` makes it the default,
 * `false` (on the default) leaves the user without one, omitted keeps it.
 */
async function putAddress(c: Ctx): Promise<Response> {
  const body = await readJsonBody(c);
  await rateLimit(c, RULES.PREFERENCES_WRITE, 'user');
  const user = await csrfProtectedUser(c);
  const validation = new Validation();
  const addressId = readPath(validation, c, 'address_id', addressIdParam);
  const payload = readBody(validation, body, savedAddressRequest);
  validation.check();
  const record = await replaceAddress(
    deps(c).db,
    user.id,
    addressId,
    addressInput(payload),
    payload.is_default ?? null,
  );
  if (record === null) throw addressNotFound();
  return c.json(savedAddress(record));
}

/** Delete one of the user's addresses; the default is handed to the most recently updated one. */
async function removeAddress(c: Ctx): Promise<Response> {
  await rateLimit(c, RULES.PREFERENCES_WRITE, 'user');
  const user = await csrfProtectedUser(c);
  const validation = new Validation();
  const addressId = readPath(validation, c, 'address_id', addressIdParam);
  validation.check();
  if (!(await deleteAddress(deps(c).db, user.id, addressId))) throw addressNotFound();
  return noContent();
}

export function register(router: Router): void {
  router.patch('/me', patchMe);
  router.put('/me/language', putLanguage);
  router.get('/me/addresses', getAddresses);
  router.post('/me/addresses', postAddress);
  router.put('/me/addresses/{address_id}', putAddress);
  router.delete('/me/addresses/{address_id}', removeAddress);
}
