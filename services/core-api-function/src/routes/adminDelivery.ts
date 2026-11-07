/**
 * Admin: delivery zones and delivery slots (`admin` role only); port of
 * services/api/app/api/routes/admin_delivery.py and app/schemas/admin_delivery.py.
 *
 * Operators get `403 forbidden` like customers, before anything is read. Reads use `admin_read`,
 * writes `admin_write` plus the CSRF token. Each change writes its audit row in the same
 * transaction. Times are local Asia/Tashkent `HH:MM`; slot dates are local calendar dates.
 */

import { AuditInstant, type AuditValue } from '../audit.ts';
import { ApiError } from '../errors.ts';
import { auditActorOf } from '../http/auth.ts';
import { deps, type Ctx } from '../http/context.ts';
import { DISTRICT_CODES, DISTRICT_NAMES, hhmm, slotCutoffIsValid } from '../domain/delivery.ts';
import { hasInvisibleCharacters, INVISIBLE_TEXT_MESSAGE } from '../domain/text.ts';
import { parseAwareIsoMicros } from '../domain/catalogCsv.ts';
import {
  AdminDeliveryError,
  AdminDeliveryRepository,
  CapacityBelowReservedError,
  DistrictTakenError,
  InvalidValueError,
  SlotExistsError,
  SlotInUseError,
  SlotNotFoundError,
  ZoneInUseError,
  ZoneNotFoundError,
  ZoneSlugTakenError,
  type AdminSlotRecord,
  type AdminZoneRecord,
} from '../repositories/adminDelivery.ts';
import { adminRead, adminWrite } from './adminCatalog.ts';
import {
  after,
  before,
  bool,
  date,
  int,
  internalError,
  INVALID,
  json,
  list,
  model,
  noContent,
  nullable,
  ok,
  oneOf,
  optional,
  pathUuid,
  queryParam,
  queryValues,
  readJsonBody,
  required,
  str,
  throwIfInvalid,
  uuid,
  validateBody,
  ValueErr,
  type Invalid,
  type Issues,
  type ModelResult,
  type V,
} from './adminCommon.ts';
import type { Router } from './index.ts';

export const MAX_MONEY_UZS = 10 ** 12;
export const MAX_SORT_ORDER = 100_000;
export const MAX_SLOT_CAPACITY = 10_000;
const HHMM_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// eslint-disable-next-line no-control-regex
const CONTROL_OR_NEWLINE = /[\x00-\x1f\x7f]/;

function toApiError(error: unknown): unknown {
  if (!(error instanceof AdminDeliveryError)) return error;
  if (error instanceof DistrictTakenError) {
    return new ApiError(409, 'district_taken', 'District belongs to another zone', {
      extra: { district: error.district },
    });
  }
  if (error instanceof InvalidValueError) {
    return new ApiError(422, 'validation_error', 'Request validation failed', {
      extra: { details: [{ loc: ['body', error.field], msg: error.message }] },
    });
  }
  if (error instanceof ZoneNotFoundError)
    return new ApiError(404, 'zone_not_found', 'Delivery zone not found');
  if (error instanceof SlotNotFoundError)
    return new ApiError(404, 'slot_not_found', 'Delivery slot not found');
  if (error instanceof ZoneSlugTakenError)
    return new ApiError(409, 'slug_taken', 'Another zone uses this slug');
  if (error instanceof ZoneInUseError) {
    return new ApiError(409, 'zone_in_use', 'Orders or slots use this zone; deactivate it instead');
  }
  if (error instanceof SlotExistsError) {
    return new ApiError(409, 'slot_exists', 'The zone already has a slot starting then');
  }
  if (error instanceof SlotInUseError)
    return new ApiError(409, 'slot_in_use', 'Places in this slot are booked');
  if (error instanceof CapacityBelowReservedError) {
    return new ApiError(
      409,
      'capacity_below_reserved',
      'Capacity is below the places already booked',
    );
  }
  return internalError();
}

async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toApiError(error);
  }
}

// --- request schemas ------------------------------------------------------------------------------

/** Exactly `HH:MM` -> Python `time` (`HH:MM:00`, its isoformat and PostgreSQL's text form). */
const ClockTime: V<string> = before((value) => {
  if (typeof value === 'string' && HHMM_PATTERN.test(value)) return `${value}:00`;
  throw new ValueErr('must be a time as HH:MM (00:00-23:59)');
});

function singleLine(value: string): string {
  if (CONTROL_OR_NEWLINE.test(value)) throw new ValueErr('must be a single line of text');
  if (hasInvisibleCharacters(value)) throw new ValueErr(INVISIBLE_TEXT_MESSAGE);
  return value;
}

const Slug = str({
  strip: true,
  minLength: 1,
  maxLength: 64,
  pattern: [SLUG_PATTERN, '^[a-z0-9]+(?:-[a-z0-9]+)*$'],
});
const Name = after(str({ strip: true, minLength: 1, maxLength: 255 }), singleLine);
const Money = int({ ge: 0, le: MAX_MONEY_UZS });
const SortOrder = int({ ge: -MAX_SORT_ORDER, le: MAX_SORT_ORDER });
const Capacity = int({ ge: 0, le: MAX_SLOT_CAPACITY });
const Districts = after(list(oneOf(DISTRICT_CODES), { minLength: 1, maxLength: 12 }), (value) => {
  if (new Set(value).size !== value.length) throw new ValueErr('districts must not repeat');
  return value;
});

const AWARE_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * Pydantic `AwareDatetime` from a string: the instant, rendered like Python's
 * `datetime.isoformat()` with the offset the client sent (`Z` becomes `+00:00`).
 */
const AwareDatetime: V<AuditInstant> = (value, loc, issues) => {
  const fail = (msg: string): Invalid => {
    issues.push({ loc: [...loc], msg });
    return INVALID;
  };
  if (typeof value !== 'string') return fail('Input should be a valid datetime');
  const match = AWARE_DATETIME.exec(value);
  if (!match) return fail('Input should be a valid datetime or date, invalid datetime separator');
  const [, y, mo, d, h, mi, s = '00', fraction = '', zone] = match;
  if (zone === undefined) return fail('Input should have timezone info');
  const normalizedZone =
    zone === 'Z' || zone === 'z'
      ? '+00:00'
      : `${zone.slice(0, 3)}:${zone.length > 3 ? zone.slice(-2) : '00'}`;
  const micros = fraction.padEnd(6, '0');
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${micros === '000000' ? '' : `.${micros}`}${normalizedZone}`;
  const epochMicros = parseAwareIsoMicros(iso);
  if (epochMicros === null) return fail('Input should be a valid datetime, invalid date or time');
  return new AuditInstant(epochMicros, iso);
};

/** A `PATCH` field that may be omitted but not set to `null`. */
const notNull = <T>(inner: V<T>): V<T | null> =>
  after(nullable(inner), (value) => {
    if (value === null) throw new ValueErr('may be omitted but not null');
    return value;
  });

const ZoneCreate = model(
  {
    slug: required(Slug),
    name_uz: required(Name),
    name_ru: required(Name),
    delivery_fee_uzs: required(Money),
    free_delivery_threshold_uzs: optional(nullable(Money)),
    min_order_uzs: optional(Money, 0),
    opens_at: required(ClockTime),
    closes_at: required(ClockTime),
    sort_order: optional(SortOrder, 0),
    is_active: optional(bool, true),
    districts: required(Districts),
  },
  ({ values }) => {
    if ((values['opens_at'] as string) >= (values['closes_at'] as string)) {
      throw new ValueErr('opens_at must be before closes_at');
    }
  },
);

const ZoneUpdate = model({
  slug: optional(notNull(Slug)),
  name_uz: optional(notNull(Name)),
  name_ru: optional(notNull(Name)),
  delivery_fee_uzs: optional(notNull(Money)),
  free_delivery_threshold_uzs: optional(nullable(Money)),
  min_order_uzs: optional(notNull(Money)),
  opens_at: optional(notNull(ClockTime)),
  closes_at: optional(notNull(ClockTime)),
  sort_order: optional(notNull(SortOrder)),
  is_active: optional(notNull(bool)),
  districts: optional(notNull(Districts)),
});

const SlotCreate = model(
  {
    zone_id: required(uuid),
    slot_date: required(date),
    starts_at: required(ClockTime),
    ends_at: required(ClockTime),
    capacity: required(Capacity),
    cutoff_at: required(AwareDatetime),
    is_active: optional(bool, true),
  },
  ({ values }) => {
    if ((values['starts_at'] as string) >= (values['ends_at'] as string)) {
      throw new ValueErr('starts_at must be before ends_at');
    }
    const cutoff = values['cutoff_at'] as AuditInstant;
    if (
      !slotCutoffIsValid(
        values['slot_date'] as string,
        values['starts_at'] as string,
        Number(cutoff.epochMicros) / 1e6,
      )
    ) {
      throw new ValueErr('cutoff_at must not be after the slot starts');
    }
  },
);

const SlotUpdate = model({
  slot_date: optional(notNull(date)),
  starts_at: optional(notNull(ClockTime)),
  ends_at: optional(notNull(ClockTime)),
  capacity: optional(notNull(Capacity)),
  cutoff_at: optional(notNull(AwareDatetime)),
  is_active: optional(notNull(bool)),
});

/** The sent fields in sorted order (`ZoneUpdateRequest.changes()`). */
function sortedChanges({ values, fieldsSet }: ModelResult): Record<string, AuditValue> {
  const changes: Record<string, AuditValue> = {};
  for (const name of [...fieldsSet].sort()) changes[name] = values[name] as AuditValue;
  return changes;
}

// --- responses ------------------------------------------------------------------------------------

function zoneOut(zone: AdminZoneRecord) {
  return {
    id: zone.id,
    slug: zone.slug,
    name_uz: zone.name_uz,
    name_ru: zone.name_ru,
    delivery_fee_uzs: zone.delivery_fee_uzs,
    free_delivery_threshold_uzs: zone.free_delivery_threshold_uzs,
    min_order_uzs: zone.min_order_uzs,
    opens_at: hhmm(zone.opens_at),
    closes_at: hhmm(zone.closes_at),
    sort_order: zone.sort_order,
    is_active: zone.is_active,
    districts: zone.districts.map((code) => ({
      code,
      name_uz: DISTRICT_NAMES[code].uz,
      name_ru: DISTRICT_NAMES[code].ru,
    })),
    created_at: zone.created_at,
    updated_at: zone.updated_at,
  };
}

function slotOut(slot: AdminSlotRecord) {
  return {
    id: slot.id,
    zone_id: slot.zone_id,
    slot_date: slot.slot_date,
    starts_at: hhmm(slot.starts_at),
    ends_at: hhmm(slot.ends_at),
    capacity: slot.capacity,
    reserved_count: slot.reserved_count,
    remaining: Math.max(0, slot.capacity - slot.reserved_count),
    cutoff_at: slot.cutoff_at,
    is_active: slot.is_active,
    created_at: slot.created_at,
    updated_at: slot.updated_at,
  };
}

const repo = (c: Ctx): AdminDeliveryRepository => new AdminDeliveryRepository(deps(c).db);

// --- handlers -------------------------------------------------------------------------------------

async function listZones(c: Ctx): Promise<Response> {
  await adminRead(c);
  return json({ items: (await repo(c).listZones()).map(zoneOut) });
}

async function createZone(c: Ctx): Promise<Response> {
  const body = await readJsonBody(c);
  const admin = await adminWrite(c);
  const issues: Issues = [];
  const payload = validateBody(body, ZoneCreate, issues);
  throwIfInvalid(issues);
  const { values } = ok(payload);
  const { districts, ...fields } = values;
  const record = await mapped(() =>
    repo(c).createZone(fields, new Set(districts as string[]), auditActorOf(admin)),
  );
  deps(c).logger.info(`Delivery zone created: ${record.id}`);
  return json(zoneOut(record), 201);
}

async function updateZone(c: Ctx): Promise<Response> {
  const body = await readJsonBody(c);
  const admin = await adminWrite(c);
  const issues: Issues = [];
  const id = pathUuid(c, 'zone_id', issues);
  const payload = validateBody(body, ZoneUpdate, issues);
  throwIfInvalid(issues);
  const record = await mapped(() =>
    repo(c).updateZone(ok(id), sortedChanges(ok(payload)), auditActorOf(admin)),
  );
  return json(zoneOut(record));
}

async function deleteZone(c: Ctx): Promise<Response> {
  const admin = await adminWrite(c);
  const issues: Issues = [];
  const id = pathUuid(c, 'zone_id', issues);
  throwIfInvalid(issues);
  await mapped(() => repo(c).deleteZone(ok(id), auditActorOf(admin)));
  return noContent();
}

async function listSlots(c: Ctx): Promise<Response> {
  await adminRead(c);
  const issues: Issues = [];
  const query = queryValues(c);
  const zoneId = queryParam(query, 'zone_id', uuid, null as string | null, issues);
  const dateFrom = queryParam(query, 'date_from', date, null as string | null, issues);
  const dateTo = queryParam(query, 'date_to', date, null as string | null, issues);
  throwIfInvalid(issues);
  const from = ok(dateFrom);
  const to = ok(dateTo);
  if (from !== null && to !== null && to < from) {
    throw new ApiError(422, 'validation_error', 'Request validation failed', {
      extra: {
        details: [{ loc: ['query', 'date_to'], msg: 'date_to must not be before date_from' }],
      },
    });
  }
  const record = await repo(c).listSlots({ zoneId: ok(zoneId), dateFrom: from, dateTo: to });
  return json({ items: record.items.map(slotOut), truncated: record.truncated });
}

async function createSlot(c: Ctx): Promise<Response> {
  const body = await readJsonBody(c);
  const admin = await adminWrite(c);
  const issues: Issues = [];
  const payload = validateBody(body, SlotCreate, issues);
  throwIfInvalid(issues);
  const record = await mapped(() =>
    repo(c).createSlot(ok(payload).values as Record<string, AuditValue>, auditActorOf(admin)),
  );
  deps(c).logger.info(`Delivery slot created: ${record.id}`);
  return json(slotOut(record), 201);
}

async function updateSlot(c: Ctx): Promise<Response> {
  const body = await readJsonBody(c);
  const admin = await adminWrite(c);
  const issues: Issues = [];
  const id = pathUuid(c, 'slot_id', issues);
  const payload = validateBody(body, SlotUpdate, issues);
  throwIfInvalid(issues);
  const record = await mapped(() =>
    repo(c).updateSlot(ok(id), sortedChanges(ok(payload)), auditActorOf(admin)),
  );
  return json(slotOut(record));
}

async function deleteSlot(c: Ctx): Promise<Response> {
  const admin = await adminWrite(c);
  const issues: Issues = [];
  const id = pathUuid(c, 'slot_id', issues);
  throwIfInvalid(issues);
  await mapped(() => repo(c).deleteSlot(ok(id), auditActorOf(admin)));
  return noContent();
}

export function register(router: Router): void {
  router.get('/admin/delivery/zones', listZones);
  router.post('/admin/delivery/zones', createZone);
  router.patch('/admin/delivery/zones/{zone_id}', updateZone);
  router.delete('/admin/delivery/zones/{zone_id}', deleteZone);
  router.get('/admin/delivery/slots', listSlots);
  router.post('/admin/delivery/slots', createSlot);
  router.patch('/admin/delivery/slots/{slot_id}', updateSlot);
  router.delete('/admin/delivery/slots/{slot_id}', deleteSlot);
}
