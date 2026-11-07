/**
 * Admin management of delivery zones and delivery slots, with an audit row per change (port of
 * services/api/app/repositories/admin_delivery.py).
 *
 * Every write is one transaction that also inserts its `zone.*` / `slot.*` audit row. Rows are
 * locked `FOR UPDATE` before they are checked and changed: a zone before its districts are
 * replaced or it is deleted; a slot before its capacity, times or state change (order creation
 * books a slot with a conditional `UPDATE` on the same row, so the two serialise). A delete that
 * loses a race to a new reference is refused by the `RESTRICT` foreign key and reported as
 * `ZoneInUseError` / `SlotInUseError`, never as a server error.
 */

import {
  AuditEntity,
  AuditInstant,
  diffFields,
  recordAudit,
  type AuditActor,
  type AuditValue,
  type FieldChanges,
} from '../audit.ts';
import type { Database, Queryable } from '../db.ts';
import { DISTRICT_CODES, slotCutoffIsValid, type DistrictCode } from '../domain/delivery.ts';
import { isoSql } from '../http/serialize.ts';

/** The admin slot list returns at most this many rows (narrow the filters for more). */
export const MAX_SLOT_LIST = 1000;

const ZONE_SLUG_CONSTRAINT = 'uq_delivery_zones_slug';
const SLOT_UNIQUE_CONSTRAINT = 'uq_delivery_slots_zone_id_slot_date_starts_at';
const ZONE_REFERENCE_SUFFIX = '_delivery_zones';
const SLOT_REFERENCE_SUFFIX = '_delivery_slots';

export const ZONE_FIELDS = [
  'slug',
  'name_uz',
  'name_ru',
  'delivery_fee_uzs',
  'free_delivery_threshold_uzs',
  'min_order_uzs',
  'opens_at',
  'closes_at',
  'sort_order',
  'is_active',
] as const;
export const SLOT_FIELDS = [
  'slot_date',
  'starts_at',
  'ends_at',
  'capacity',
  'cutoff_at',
  'is_active',
] as const;
/** A slot's place in time; changing it would move customers who already booked it. */
const SLOT_TIME_FIELDS: ReadonlySet<string> = new Set(['slot_date', 'starts_at', 'ends_at']);

// --- errors ---------------------------------------------------------------------------------------

export class AdminDeliveryError extends Error {}
export class ZoneNotFoundError extends AdminDeliveryError {}
export class SlotNotFoundError extends AdminDeliveryError {}
export class ZoneSlugTakenError extends AdminDeliveryError {}
export class DistrictTakenError extends AdminDeliveryError {
  readonly district: string;
  constructor(district: string) {
    super(`district ${district} belongs to another zone`);
    this.district = district;
  }
}
export class ZoneInUseError extends AdminDeliveryError {}
export class SlotExistsError extends AdminDeliveryError {}
export class SlotInUseError extends AdminDeliveryError {}
export class CapacityBelowReservedError extends AdminDeliveryError {
  readonly reservedCount: number;
  constructor(reservedCount: number) {
    super(`${reservedCount} places are already booked`);
    this.reservedCount = reservedCount;
  }
}
/** The merged result of a partial update is inconsistent (reported as a 422). */
export class InvalidValueError extends AdminDeliveryError {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

// --- records --------------------------------------------------------------------------------------

export interface AdminZoneRecord {
  id: string;
  slug: string;
  name_uz: string;
  name_ru: string;
  delivery_fee_uzs: number;
  free_delivery_threshold_uzs: number | null;
  min_order_uzs: number;
  /** PostgreSQL `time` text, `HH:MM:SS`. */
  opens_at: string;
  closes_at: string;
  sort_order: number;
  is_active: boolean;
  /** District codes in the documented, stable order. */
  districts: DistrictCode[];
  created_at: string;
  updated_at: string;
}

export interface AdminSlotRecord {
  id: string;
  zone_id: string;
  slot_date: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  reserved_count: number;
  cutoff_at: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface SlotRow extends AdminSlotRecord {
  cutoff_micros: string;
  cutoff_iso: string;
}

// --- helpers --------------------------------------------------------------------------------------

function constraintOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  if (code !== '23505' && code !== '23503') return null;
  return typeof constraint === 'string' ? constraint : null;
}

function isReferenceTo(error: unknown, suffix: string): boolean {
  const name = constraintOf(error) ?? '';
  return name.startsWith('fk_') && name.endsWith(suffix);
}

/** Run `work`; a violation of `constraint` becomes `mapped()`. */
async function mapConstraint<T>(
  constraint: string,
  mapped: () => Error,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (constraintOf(error) === constraint) throw mapped();
    throw error;
  }
}

const ZONE_COLUMNS = `
  z.id::text AS id, z.slug, z.name_uz, z.name_ru, z.delivery_fee_uzs,
  z.free_delivery_threshold_uzs, z.min_order_uzs, z.opens_at::text AS opens_at,
  z.closes_at::text AS closes_at, z.sort_order, z.is_active,
  ${isoSql('z.created_at')} AS created_at, ${isoSql('z.updated_at')} AS updated_at`;

const SLOT_COLUMNS = `
  s.id::text AS id, s.zone_id::text AS zone_id, to_char(s.slot_date, 'YYYY-MM-DD') AS slot_date,
  s.starts_at::text AS starts_at, s.ends_at::text AS ends_at, s.capacity, s.reserved_count,
  ${isoSql('s.cutoff_at')} AS cutoff_at, s.is_active,
  ${isoSql('s.created_at')} AS created_at, ${isoSql('s.updated_at')} AS updated_at,
  (extract(epoch FROM date_trunc('second', s.cutoff_at))::bigint * 1000000
    + extract(microseconds FROM s.cutoff_at)::bigint % 1000000)::text AS cutoff_micros,
  regexp_replace(to_char(s.cutoff_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
                 '\\.000000$', '') || '+00:00' AS cutoff_iso`;

function slotRecord(row: SlotRow): AdminSlotRecord {
  return {
    id: row.id,
    zone_id: row.zone_id,
    slot_date: row.slot_date,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    capacity: row.capacity,
    reserved_count: row.reserved_count,
    cutoff_at: row.cutoff_at,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** The audited slot values (`cutoff_at` as an instant, like the Python `datetime`). */
function slotValues(row: SlotRow): Record<string, AuditValue> {
  return {
    slot_date: row.slot_date,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    capacity: row.capacity,
    cutoff_at: new AuditInstant(BigInt(row.cutoff_micros), row.cutoff_iso),
    is_active: row.is_active,
  };
}

function zoneValues(zone: AdminZoneRecord | Record<string, unknown>): Record<string, AuditValue> {
  const source = zone as Record<string, AuditValue>;
  const out: Record<string, AuditValue> = {};
  for (const field of ZONE_FIELDS) out[field] = source[field] ?? null;
  return out;
}

function ordered(districts: Iterable<string>): DistrictCode[] {
  const set = new Set(districts);
  return DISTRICT_CODES.filter((code) => set.has(code));
}

const sorted = (values: Iterable<string>): string[] => [...values].sort();

/** The rules a slot must satisfy as a whole (also after a partial update). */
export function checkSlotValues(values: Readonly<Record<string, AuditValue>>): void {
  if ((values['starts_at'] as string) >= (values['ends_at'] as string)) {
    throw new InvalidValueError('ends_at', 'starts_at must be before ends_at');
  }
  const cutoff = values['cutoff_at'] as AuditInstant;
  if (
    !slotCutoffIsValid(
      values['slot_date'] as string,
      values['starts_at'] as string,
      Number(cutoff.epochMicros) / 1e6,
    )
  ) {
    throw new InvalidValueError('cutoff_at', 'cutoff_at must not be after the slot starts');
  }
}

/** Value for a `timestamptz` parameter. */
const sqlValue = (value: AuditValue): unknown =>
  value instanceof AuditInstant ? value.iso : value;

// --- repository -----------------------------------------------------------------------------------

export class AdminDeliveryRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  // --- zones ------------------------------------------------------------------------------------

  async listZones(): Promise<AdminZoneRecord[]> {
    const { rows } = await this.db.query<Omit<AdminZoneRecord, 'districts'>>(
      `SELECT ${ZONE_COLUMNS} FROM delivery_zones z ORDER BY z.sort_order, z.slug`,
    );
    const districts = await this.districtsOf(
      this.db.pool,
      rows.map((row) => row.id),
    );
    return rows.map((row) => ({ ...row, districts: ordered(districts.get(row.id) ?? []) }));
  }

  async createZone(
    values: Record<string, unknown>,
    districts: ReadonlySet<string>,
    actor: AuditActor,
  ): Promise<AdminZoneRecord> {
    return this.db.tx(async (client) => {
      await this.ensureSlugFree(client, values['slug'] as string, null);
      const { rows } = await mapConstraint(
        ZONE_SLUG_CONSTRAINT,
        () => new ZoneSlugTakenError(),
        () =>
          client.query<{ id: string }>(
            `INSERT INTO delivery_zones (id, slug, name_uz, name_ru, delivery_fee_uzs,
             free_delivery_threshold_uzs, min_order_uzs, opens_at, closes_at, sort_order, is_active)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id::text AS id`,
            ZONE_FIELDS.map((field) => values[field] ?? null),
          ),
      );
      const id = rows[0]?.id as string;
      await this.claimDistricts(client, id, districts);
      const changes: FieldChanges = {};
      for (const [field, value] of Object.entries(zoneValues(values)))
        changes[field] = [null, value];
      changes['districts'] = [null, sorted(districts)];
      await recordAudit(client, actor, {
        action: 'zone.create',
        entityType: AuditEntity.ZONE,
        entityId: id,
        changes,
        extra: { slug: values['slug'] as string, district_count: districts.size },
      });
      return this.loadZone(client, id);
    });
  }

  async updateZone(
    zoneId: string,
    changes: Record<string, unknown>,
    actor: AuditActor,
  ): Promise<AdminZoneRecord> {
    return this.db.tx(async (client) => {
      const zone = await this.lockZone(client, zoneId);
      const before = zoneValues(zone);
      const after = { ...before };
      for (const [field, value] of Object.entries(changes)) {
        if ((ZONE_FIELDS as readonly string[]).includes(field)) after[field] = value as AuditValue;
      }
      if ((after['opens_at'] as string) >= (after['closes_at'] as string)) {
        throw new InvalidValueError('closes_at', 'opens_at must be before closes_at');
      }
      if (after['slug'] !== before['slug']) {
        await this.ensureSlugFree(client, after['slug'] as string, zoneId);
      }
      const oldDistricts = new Set((await this.districtsOf(client, [zoneId])).get(zoneId) ?? []);
      const newDistricts = new Set(
        'districts' in changes ? (changes['districts'] as string[]) : oldDistricts,
      );

      const fieldChanges = diffFields(before, after);
      const fields = Object.keys(fieldChanges);
      if (fields.length > 0) {
        await mapConstraint(
          ZONE_SLUG_CONSTRAINT,
          () => new ZoneSlugTakenError(),
          () =>
            client.query(
              `UPDATE delivery_zones SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(', ')},
               updated_at = now() WHERE id = $1`,
              [zoneId, ...fields.map((field) => fieldChanges[field]?.[1] ?? null)],
            ),
        );
      }
      const same =
        newDistricts.size === oldDistricts.size &&
        [...newDistricts].every((d) => oldDistricts.has(d));
      if (!same) {
        await client.query(
          'DELETE FROM delivery_zone_districts WHERE zone_id = $1 AND NOT (district = ANY($2::text[]))',
          [zoneId, [...newDistricts]],
        );
        await this.claimDistricts(
          client,
          zoneId,
          new Set([...newDistricts].filter((district) => !oldDistricts.has(district))),
        );
        fieldChanges['districts'] = [sorted(oldDistricts), sorted(newDistricts)];
      }
      if (Object.keys(fieldChanges).length > 0) {
        await recordAudit(client, actor, {
          action: 'zone.update',
          entityType: AuditEntity.ZONE,
          entityId: zoneId,
          changes: fieldChanges,
          extra: { slug: after['slug'] as string, district_count: newDistricts.size },
        });
      }
      return this.loadZone(client, zoneId);
    });
  }

  async deleteZone(zoneId: string, actor: AuditActor): Promise<void> {
    try {
      await this.db.tx(async (client) => {
        const zone = await this.lockZone(client, zoneId);
        const referenced = await client.query<{ used: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM orders WHERE delivery_zone_id = $1)
               OR EXISTS (SELECT 1 FROM delivery_slots WHERE zone_id = $1) AS used`,
          [zoneId],
        );
        if (referenced.rows[0]?.used) throw new ZoneInUseError();
        const districts = sorted((await this.districtsOf(client, [zoneId])).get(zoneId) ?? []);
        await client.query('DELETE FROM delivery_zones WHERE id = $1', [zoneId]);
        await recordAudit(client, actor, {
          action: 'zone.delete',
          entityType: AuditEntity.ZONE,
          entityId: zoneId,
          changes: { districts: [districts, null] },
          extra: { slug: zone.slug, district_count: districts.length },
        });
      });
    } catch (error) {
      // A slot (or order) referencing the zone committed after the check above.
      if (isReferenceTo(error, ZONE_REFERENCE_SUFFIX)) throw new ZoneInUseError();
      throw error;
    }
  }

  private async lockZone(client: Queryable, zoneId: string): Promise<AdminZoneRecord> {
    const { rows } = await client.query<AdminZoneRecord>(
      `SELECT ${ZONE_COLUMNS} FROM delivery_zones z WHERE z.id = $1 FOR UPDATE`,
      [zoneId],
    );
    const zone = rows[0];
    if (!zone) throw new ZoneNotFoundError();
    return zone;
  }

  private async ensureSlugFree(
    client: Queryable,
    slug: string,
    zoneId: string | null,
  ): Promise<void> {
    const { rows } = await client.query(
      'SELECT id FROM delivery_zones WHERE slug = $1 AND ($2::uuid IS NULL OR id <> $2::uuid) LIMIT 1',
      [slug, zoneId],
    );
    if (rows.length > 0) throw new ZoneSlugTakenError();
  }

  /**
   * Attach `districts` to the zone; any already in another zone is `district_taken`.
   * `INSERT ... ON CONFLICT DO NOTHING`: the district primary key decides between two concurrent
   * admins, and the loser learns which district it lost.
   */
  private async claimDistricts(
    client: Queryable,
    zoneId: string,
    districts: ReadonlySet<string>,
  ): Promise<void> {
    if (districts.size === 0) return;
    const codes = sorted(districts);
    const taken = await client.query<{ district: string }>(
      `SELECT district FROM delivery_zone_districts
       WHERE district = ANY($1::text[]) AND zone_id <> $2 ORDER BY district LIMIT 1`,
      [codes, zoneId],
    );
    const first = taken.rows[0];
    if (first) throw new DistrictTakenError(first.district);
    const inserted = await client.query<{ district: string }>(
      `INSERT INTO delivery_zone_districts (district, zone_id)
       SELECT code, $2::uuid FROM unnest($1::text[]) AS code
       ON CONFLICT (district) DO NOTHING RETURNING district`,
      [codes, zoneId],
    );
    const got = new Set(inserted.rows.map((row) => row.district));
    const lost = codes.filter((code) => !got.has(code));
    if (lost.length > 0) throw new DistrictTakenError(lost[0] as string);
  }

  private async districtsOf(client: Queryable, zoneIds: string[]): Promise<Map<string, string[]>> {
    const districts = new Map<string, string[]>();
    if (zoneIds.length === 0) return districts;
    const { rows } = await client.query<{ zone_id: string; district: string }>(
      'SELECT zone_id::text AS zone_id, district FROM delivery_zone_districts WHERE zone_id = ANY($1::uuid[])',
      [zoneIds],
    );
    for (const row of rows) {
      const list = districts.get(row.zone_id) ?? [];
      list.push(row.district);
      districts.set(row.zone_id, list);
    }
    return districts;
  }

  private async loadZone(client: Queryable, zoneId: string): Promise<AdminZoneRecord> {
    const { rows } = await client.query<Omit<AdminZoneRecord, 'districts'>>(
      `SELECT ${ZONE_COLUMNS} FROM delivery_zones z WHERE z.id = $1`,
      [zoneId],
    );
    const zone = rows[0];
    if (!zone) throw new Error('zone vanished inside its transaction');
    const districts = await this.districtsOf(client, [zoneId]);
    return { ...zone, districts: ordered(districts.get(zoneId) ?? []) };
  }

  // --- slots ------------------------------------------------------------------------------------

  async listSlots(filters: {
    zoneId: string | null;
    dateFrom: string | null;
    dateTo: string | null;
  }): Promise<{ items: AdminSlotRecord[]; truncated: boolean }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filters.zoneId !== null) {
      params.push(filters.zoneId);
      conditions.push(`s.zone_id = $${params.length}`);
    }
    if (filters.dateFrom !== null) {
      params.push(filters.dateFrom);
      conditions.push(`s.slot_date >= $${params.length}::date`);
    }
    if (filters.dateTo !== null) {
      params.push(filters.dateTo);
      conditions.push(`s.slot_date <= $${params.length}::date`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(MAX_SLOT_LIST + 1);
    const { rows } = await this.db.query<SlotRow>(
      `SELECT ${SLOT_COLUMNS} FROM delivery_slots s ${where}
       ORDER BY s.slot_date, s.starts_at, s.zone_id, s.id LIMIT $${params.length}`,
      params,
    );
    return {
      items: rows.slice(0, MAX_SLOT_LIST).map(slotRecord),
      truncated: rows.length > MAX_SLOT_LIST,
    };
  }

  /** `values`: `zone_id` plus `SLOT_FIELDS` (`cutoff_at` as an `AuditInstant`). */
  async createSlot(
    values: Record<string, AuditValue>,
    actor: AuditActor,
  ): Promise<AdminSlotRecord> {
    return this.db.tx(async (client) => {
      const zone = await client.query('SELECT id FROM delivery_zones WHERE id = $1', [
        values['zone_id'],
      ]);
      if (zone.rows.length === 0) throw new ZoneNotFoundError();
      checkSlotValues(values);
      const { rows } = await mapConstraint(
        SLOT_UNIQUE_CONSTRAINT,
        () => new SlotExistsError(),
        () =>
          client.query<{ id: string }>(
            `INSERT INTO delivery_slots (id, zone_id, slot_date, starts_at, ends_at, capacity, cutoff_at, is_active)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7) RETURNING id::text AS id`,
            [values['zone_id'], ...SLOT_FIELDS.map((field) => sqlValue(values[field] ?? null))],
          ),
      );
      const id = rows[0]?.id as string;
      const changes: FieldChanges = { zone_id: [null, values['zone_id'] ?? null] };
      for (const field of SLOT_FIELDS) changes[field] = [null, values[field] ?? null];
      await recordAudit(client, actor, {
        action: 'slot.create',
        entityType: AuditEntity.SLOT,
        entityId: id,
        changes,
      });
      return slotRecord(await this.loadSlot(client, id));
    });
  }

  async updateSlot(
    slotId: string,
    changes: Record<string, AuditValue>,
    actor: AuditActor,
  ): Promise<AdminSlotRecord> {
    return this.db.tx(async (client) => {
      const slot = await this.lockSlot(client, slotId);
      const before = slotValues(slot);
      const after = { ...before };
      for (const [field, value] of Object.entries(changes)) {
        if ((SLOT_FIELDS as readonly string[]).includes(field)) after[field] = value;
      }
      const fieldChanges = diffFields(before, after);
      const fields = Object.keys(fieldChanges);
      if (fields.length === 0) return slotRecord(slot);
      if ((after['capacity'] as number) < slot.reserved_count) {
        throw new CapacityBelowReservedError(slot.reserved_count);
      }
      if (fields.some((field) => SLOT_TIME_FIELDS.has(field)) && slot.reserved_count > 0) {
        throw new SlotInUseError();
      }
      checkSlotValues(after);
      await mapConstraint(
        SLOT_UNIQUE_CONSTRAINT,
        () => new SlotExistsError(),
        () =>
          client.query(
            `UPDATE delivery_slots SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(', ')},
             updated_at = now() WHERE id = $1`,
            [slotId, ...fields.map((field) => sqlValue(fieldChanges[field]?.[1] ?? null))],
          ),
      );
      await recordAudit(client, actor, {
        action: 'slot.update',
        entityType: AuditEntity.SLOT,
        entityId: slotId,
        changes: fieldChanges,
      });
      return slotRecord(await this.loadSlot(client, slotId));
    });
  }

  async deleteSlot(slotId: string, actor: AuditActor): Promise<void> {
    try {
      await this.db.tx(async (client) => {
        const slot = await this.lockSlot(client, slotId);
        const referenced = await client.query<{ used: boolean }>(
          'SELECT EXISTS (SELECT 1 FROM orders WHERE delivery_slot_id = $1) AS used',
          [slotId],
        );
        if (slot.reserved_count > 0 || referenced.rows[0]?.used) throw new SlotInUseError();
        const removed: FieldChanges = { zone_id: [slot.zone_id, null] };
        for (const [field, value] of Object.entries(slotValues(slot)))
          removed[field] = [value, null];
        await client.query('DELETE FROM delivery_slots WHERE id = $1', [slotId]);
        await recordAudit(client, actor, {
          action: 'slot.delete',
          entityType: AuditEntity.SLOT,
          entityId: slotId,
          changes: removed,
        });
      });
    } catch (error) {
      // An order booking the slot committed after the check above.
      if (isReferenceTo(error, SLOT_REFERENCE_SUFFIX)) throw new SlotInUseError();
      throw error;
    }
  }

  private async lockSlot(client: Queryable, slotId: string): Promise<SlotRow> {
    const { rows } = await client.query<SlotRow>(
      `SELECT ${SLOT_COLUMNS} FROM delivery_slots s WHERE s.id = $1 FOR UPDATE`,
      [slotId],
    );
    const slot = rows[0];
    if (!slot) throw new SlotNotFoundError();
    return slot;
  }

  private async loadSlot(client: Queryable, slotId: string): Promise<SlotRow> {
    const { rows } = await client.query<SlotRow>(
      `SELECT ${SLOT_COLUMNS} FROM delivery_slots s WHERE s.id = $1`,
      [slotId],
    );
    const slot = rows[0];
    if (!slot) throw new Error('slot vanished inside its transaction');
    return slot;
  }
}
