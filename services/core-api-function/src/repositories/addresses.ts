/**
 * The customer's saved delivery addresses (port of services/api/app/repositories/addresses.py).
 *
 * Ownership is part of every statement (`WHERE id = $1 AND user_id = $2`), so another user's
 * address is indistinguishable from a missing one. Every write is ONE `db.tx` that first locks the
 * owner's `users` row (`FOR UPDATE`): concurrent writes for one user are serialised, so the
 * 10-address limit and the single default cannot be raced. Turning another address's default
 * flag off (or on, when promoting) is bookkeeping, not an edit: its `updated_at` stays as it was.
 */
import type { Database, Queryable } from '../db.ts';
import { isoSql } from '../http/serialize.ts';

export const MAX_SAVED_ADDRESSES = 10;

export class AddressLimitReachedError extends Error {
  constructor() {
    super('address limit reached');
    this.name = 'AddressLimitReachedError';
  }
}

/** A validated `SavedAddressRequest` without `is_default`. */
export interface AddressInput {
  label: string | null;
  lat: number;
  lon: number;
  street: string;
  house: string;
  apartment: string | null;
  entrance: string | null;
  floor: string | null;
  landmark: string | null;
}

export interface SavedAddressRecord extends AddressInput {
  id: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id::text AS id, label, lat, lon, street, house, apartment, entrance, floor,
  landmark, is_default, ${isoSql('created_at')} AS created_at,
  ${isoSql('updated_at')} AS updated_at`;

function inputParams(data: AddressInput): unknown[] {
  return [
    data.label,
    data.lat,
    data.lon,
    data.street,
    data.house,
    data.apartment,
    data.entrance,
    data.floor,
    data.landmark,
  ];
}

/** The default first, then the most recently updated. */
export async function listAddresses(db: Queryable, userId: string): Promise<SavedAddressRecord[]> {
  const { rows } = await db.query<SavedAddressRecord>(
    `SELECT ${COLUMNS} FROM user_addresses WHERE user_id = $1::uuid
      ORDER BY is_default DESC, user_addresses.updated_at DESC, user_addresses.id DESC`,
    [userId],
  );
  return rows;
}

async function lockOwner(client: Queryable, userId: string): Promise<void> {
  await client.query('SELECT id FROM users WHERE id = $1::uuid FOR UPDATE', [userId]);
}

async function unsetDefault(
  client: Queryable,
  userId: string,
  keep: string | null = null,
): Promise<void> {
  await client.query(
    `UPDATE user_addresses SET is_default = false
      WHERE user_id = $1::uuid AND is_default AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [userId, keep],
  );
}

/** Save a new address. The user's first address is the default whatever was asked. */
export async function createAddress(
  db: Database,
  userId: string,
  data: AddressInput,
  isDefault: boolean | null,
): Promise<SavedAddressRecord> {
  return db.tx(async (client) => {
    await lockOwner(client, userId);
    const counted = await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM user_addresses WHERE user_id = $1::uuid',
      [userId],
    );
    const count = counted.rows[0]?.count ?? 0;
    if (count >= MAX_SAVED_ADDRESSES) throw new AddressLimitReachedError();
    const makeDefault = count === 0 || isDefault === true;
    if (makeDefault) await unsetDefault(client, userId);
    const { rows } = await client.query<SavedAddressRecord>(
      `INSERT INTO user_addresses (user_id, label, lat, lon, street, house, apartment, entrance,
                                   floor, landmark, is_default)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${COLUMNS}`,
      [userId, ...inputParams(data), makeDefault],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('address insert returned no row');
    return row;
  });
}

/** Overwrite every field; `isDefault` true / false / null (keep). Null when not the user's. */
export async function replaceAddress(
  db: Database,
  userId: string,
  addressId: string,
  data: AddressInput,
  isDefault: boolean | null,
): Promise<SavedAddressRecord | null> {
  return db.tx(async (client) => {
    await lockOwner(client, userId);
    const owned = await client.query(
      'SELECT id FROM user_addresses WHERE id = $1::uuid AND user_id = $2::uuid',
      [addressId, userId],
    );
    if (owned.rows.length === 0) return null;
    if (isDefault === true) await unsetDefault(client, userId, addressId);
    const { rows } = await client.query<SavedAddressRecord>(
      `UPDATE user_addresses SET label = $3, lat = $4, lon = $5, street = $6, house = $7,
              apartment = $8, entrance = $9, floor = $10, landmark = $11,
              is_default = COALESCE($12::boolean, is_default), updated_at = now()
        WHERE id = $1::uuid AND user_id = $2::uuid
        RETURNING ${COLUMNS}`,
      [addressId, userId, ...inputParams(data), isDefault],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('address update returned no row');
    return row;
  });
}

/** Remove the address; deleting the default promotes the most recently updated one. */
export async function deleteAddress(
  db: Database,
  userId: string,
  addressId: string,
): Promise<boolean> {
  return db.tx(async (client) => {
    await lockOwner(client, userId);
    const deleted = await client.query<{ is_default: boolean }>(
      `DELETE FROM user_addresses WHERE id = $1::uuid AND user_id = $2::uuid
       RETURNING is_default`,
      [addressId, userId],
    );
    const removed = deleted.rows[0];
    if (removed === undefined) return false;
    if (removed.is_default) {
      await client.query(
        `UPDATE user_addresses SET is_default = true
          WHERE id = (SELECT id FROM user_addresses WHERE user_id = $1::uuid
                       ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT 1)`,
        [userId],
      );
    }
    return true;
  });
}
