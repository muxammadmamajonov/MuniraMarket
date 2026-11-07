/** Delivery zones and bookable slots (port of services/api/app/repositories/delivery.py). */
import type { Queryable } from '../db.ts';
import { matchZone, tashkentDate, type ZoneRules } from '../domain/delivery.ts';

/** What the checkout quote offers: bookable slots of the next 14 local days, at most 60. */
export const SLOT_OFFER_DAYS = 14;
export const SLOT_OFFER_LIMIT = 60;

/**
 * The one definition of "a customer can book this slot now" (capacity aside), as SQL over slot
 * alias `s` with `$now` (timestamptz) and `$today` (local Asia/Tashkent date) placeholders.
 *
 * Active, cutoff still ahead, and on one of the `SLOT_OFFER_DAYS` local days starting today. Used
 * for "the zone requires a slot", for the slots the quote offers and for the booking itself, so a
 * slot is required only if one can be offered, and a slot that is not offered (e.g. further ahead
 * than the window) cannot be booked (`slot_unavailable`).
 */
export function bookableSlot(nowParam: number, todayParam: number, alias = 's'): string {
  return (
    `(${alias}.is_active AND ${alias}.cutoff_at > $${nowParam}::timestamptz ` +
    `AND ${alias}.slot_date >= $${todayParam}::date ` +
    `AND ${alias}.slot_date < $${todayParam}::date + ${SLOT_OFFER_DAYS})`
  );
}

/** Parameters for `bookableSlot`: the instant and its local date. */
export function bookableParams(now: number): [Date, string] {
  return [new Date(now * 1000), tashkentDate(now)];
}

export interface ZoneRecord {
  zoneId: string;
  isActive: boolean;
  districts: ReadonlySet<string>;
  slug: string;
  nameUz: string;
  nameRu: string;
  rules: ZoneRules;
  sortOrder: number;
}

/** A delivery slot as offered at checkout (active, cutoff still ahead). */
export interface SlotOptionRecord {
  id: string;
  /** `YYYY-MM-DD` (local Asia/Tashkent). */
  slotDate: string;
  /** `HH:MM:SS` (local Asia/Tashkent). */
  startsAt: string;
  endsAt: string;
  capacity: number;
  reservedCount: number;
}

export function slotRemaining(slot: SlotOptionRecord): number {
  return Math.max(0, slot.capacity - slot.reservedCount);
}

interface ZoneRow {
  id: string;
  is_active: boolean;
  slug: string;
  name_uz: string;
  name_ru: string;
  delivery_fee_uzs: number;
  free_delivery_threshold_uzs: number | null;
  min_order_uzs: number;
  opens_at: string;
  closes_at: string;
  sort_order: number;
  districts: string[];
}

/** Active zones in display order, each with its districts. */
export async function listActiveZones(db: Queryable): Promise<ZoneRecord[]> {
  const { rows } = await db.query<ZoneRow>(
    `SELECT z.id::text AS id, z.is_active, z.slug, z.name_uz, z.name_ru, z.delivery_fee_uzs,
            z.free_delivery_threshold_uzs, z.min_order_uzs, z.opens_at::text AS opens_at,
            z.closes_at::text AS closes_at, z.sort_order,
            COALESCE(ARRAY(SELECT d.district::text FROM delivery_zone_districts d
                            WHERE d.zone_id = z.id), '{}') AS districts
       FROM delivery_zones z
      WHERE z.is_active
      ORDER BY z.sort_order, z.slug`,
  );
  return rows.map((row) => ({
    zoneId: row.id,
    isActive: row.is_active,
    districts: new Set(row.districts),
    slug: row.slug,
    nameUz: row.name_uz,
    nameRu: row.name_ru,
    rules: {
      deliveryFeeUzs: row.delivery_fee_uzs,
      freeDeliveryThresholdUzs: row.free_delivery_threshold_uzs,
      minOrderUzs: row.min_order_uzs,
      opensAt: row.opens_at,
      closesAt: row.closes_at,
    },
    sortOrder: row.sort_order,
  }));
}

/** The active zone delivering to `district`, else `null`. */
export async function findZoneForDistrict(
  db: Queryable,
  district: string,
): Promise<ZoneRecord | null> {
  return matchZone(district, await listActiveZones(db));
}

/**
 * Whether the zone has any bookable slot; then one is required at checkout. Full slots count:
 * the zone runs on slots, they are just taken.
 */
export async function hasBookableSlot(
  db: Queryable,
  zoneId: string,
  now: number,
): Promise<boolean> {
  const { rows } = await db.query<{ found: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM delivery_slots s
                     WHERE s.zone_id = $1 AND ${bookableSlot(2, 3)}) AS found`,
    [zoneId, ...bookableParams(now)],
  );
  return rows[0]?.found === true;
}

/**
 * Bookable slots by date and start time, at most `SLOT_OFFER_LIMIT` (full ones included, so the
 * customer sees them as taken).
 */
export async function offeredSlots(
  db: Queryable,
  zoneId: string,
  now: number,
): Promise<SlotOptionRecord[]> {
  const { rows } = await db.query<{
    id: string;
    slot_date: string;
    starts_at: string;
    ends_at: string;
    capacity: number;
    reserved_count: number;
  }>(
    `SELECT s.id::text AS id, to_char(s.slot_date, 'YYYY-MM-DD') AS slot_date,
            s.starts_at::text AS starts_at, s.ends_at::text AS ends_at, s.capacity,
            s.reserved_count
       FROM delivery_slots s
      WHERE s.zone_id = $1 AND ${bookableSlot(2, 3)}
      ORDER BY s.slot_date, s.starts_at, s.id
      LIMIT ${SLOT_OFFER_LIMIT}`,
    [zoneId, ...bookableParams(now)],
  );
  return rows.map((row) => ({
    id: row.id,
    slotDate: row.slot_date,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    capacity: row.capacity,
    reservedCount: row.reserved_count,
  }));
}
