import type { Queryable } from './db.ts';
import type { UserRole } from './http/context.ts';

/**
 * Append-only audit log of back-office changes (port of services/api/app/audit.py).
 *
 * `recordAudit` inserts one `audit_log` row with the caller's transaction client, so it commits
 * or rolls back together with the change it describes. Field changes are `{field: [before,
 * after]}`; `safeDetails` keeps only allow-listed field names with scalar values, so a careless
 * caller cannot leak personal data (phones, addresses, names, free-text reasons, initData,
 * cookies, tokens) into a table that is kept forever.
 */

export const MAX_TEXT_LENGTH = 200;

/** Field names that may appear in `changes`, per entity type. Anything else is dropped. */
export const ALLOWED_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  category: new Set([
    'slug',
    'name_uz',
    'name_ru',
    'parent_id',
    'sort_order',
    'is_active',
    'image_url',
  ]),
  product: new Set([
    'sku',
    'slug',
    'name_uz',
    'name_ru',
    'category_id',
    'unit',
    'price_uzs',
    'old_price_uzs',
    'stock_quantity',
    'is_active',
    'sort_order',
    'image_url',
    'archived',
  ]),
  zone: new Set([
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
    'districts',
  ]),
  slot: new Set([
    'zone_id',
    'slot_date',
    'starts_at',
    'ends_at',
    'capacity',
    'cutoff_at',
    'is_active',
  ]),
  user: new Set(['role', 'is_blocked']),
  order: new Set(['status']),
  catalog: new Set(),
};

/** Keys allowed in `extra` (context that is not a field change). */
export const ALLOWED_EXTRA: ReadonlySet<string> = new Set([
  'source',
  'order_number',
  'has_reason',
  'rows',
  'creates',
  'updates',
  'unchanged',
  'sku',
  'slug',
  'district_count',
]);
/** Allow-listed flags whose name contains a denied word: only a boolean is kept. */
const FLAG_EXTRA: ReadonlySet<string> = new Set(['has_reason']);

/** Defence in depth: even an allow-listed name is refused if it looks personal or secret. */
const DENY =
  /phone|address|recipient|comment|init_?data|token|cookie|csrf|password|secret|username|first_name|last_name|telegram|reason|description|street|house|apartment|landmark/i;

export const AuditEntity = {
  CATEGORY: 'category',
  PRODUCT: 'product',
  CATALOG: 'catalog',
  ZONE: 'zone',
  SLOT: 'slot',
  USER: 'user',
  ORDER: 'order',
  STAFF_CHAT: 'staff_chat',
} as const;

export interface AuditActor {
  /** `null` for changes made by the system rather than a signed-in user. */
  userId: string | null;
  role: UserRole;
}

/**
 * A timezone-aware instant with the text Python's `datetime.isoformat()` gives it. Compared by
 * instant (like Python datetimes), rendered with the offset it was given (`+00:00` for values
 * read from PostgreSQL, the client's offset for request values).
 */
export class AuditInstant {
  readonly epochMicros: bigint;
  readonly iso: string;
  constructor(epochMicros: bigint, iso: string) {
    this.epochMicros = epochMicros;
    this.iso = iso;
  }
}

export type AuditValue =
  null | undefined | boolean | number | string | AuditInstant | readonly (string | number)[];

export type Scalar = string | number | boolean | null;
export type FieldChanges = Record<string, readonly [AuditValue, AuditValue]>;

function truncate(value: string): string {
  const chars = [...value];
  return chars.length <= MAX_TEXT_LENGTH
    ? value
    : `${chars.slice(0, MAX_TEXT_LENGTH - 1).join('')}…`;
}

function scalar(value: AuditValue): Scalar {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string') return truncate(value);
  if (value instanceof AuditInstant) return value.iso;
  if (Array.isArray(value)) {
    // Only short collections of identifiers (e.g. district codes) are meaningful here.
    const items = value.map((item) => String(item)).sort();
    return truncate(items.join(','));
  }
  return null;
}

/** `{"changes": {field: {"from": .., "to": ..}}, ...extra}` with everything unsafe dropped. */
export function safeDetails(
  entityType: string,
  changes: FieldChanges | null = null,
  extra: Readonly<Record<string, AuditValue>> | null = null,
): Record<string, unknown> {
  const allowed = ALLOWED_FIELDS[entityType] ?? new Set<string>();
  const safeChanges: Record<string, { from: Scalar; to: Scalar }> = {};
  let any = false;
  for (const [field, [before, after]] of Object.entries(changes ?? {})) {
    if (!allowed.has(field) || DENY.test(field)) continue;
    safeChanges[field] = { from: scalar(before), to: scalar(after) };
    any = true;
  }
  const details: Record<string, unknown> = {};
  if (any) details['changes'] = safeChanges;
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (FLAG_EXTRA.has(key)) {
      if (typeof value === 'boolean') details[key] = value;
    } else if (ALLOWED_EXTRA.has(key) && !DENY.test(key)) {
      details[key] = scalar(value);
    }
  }
  return details;
}

/** Python `==` for the values audit callers compare. */
export function sameValue(a: AuditValue, b: AuditValue): boolean {
  const left = a === undefined ? null : a;
  const right = b === undefined ? null : b;
  if (left instanceof AuditInstant || right instanceof AuditInstant) {
    return (
      left instanceof AuditInstant &&
      right instanceof AuditInstant &&
      left.epochMicros === right.epochMicros
    );
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => item === right[index])
    );
  }
  return left === right;
}

/** The `{field: [before, after]}` pairs whose value changed (in `after`'s key order). */
export function diffFields(
  before: Readonly<Record<string, AuditValue>>,
  after: Readonly<Record<string, AuditValue>>,
): FieldChanges {
  const changes: FieldChanges = {};
  for (const [field, value] of Object.entries(after)) {
    const previous = before[field] ?? null;
    if (!sameValue(previous, value)) changes[field] = [previous, value];
  }
  return changes;
}

export interface AuditEntryInput {
  action: string;
  entityType: string;
  entityId: string;
  changes?: FieldChanges | null;
  extra?: Readonly<Record<string, AuditValue>> | null;
}

/** Insert an audit row with `client` (the caller's transaction). */
export async function recordAudit(
  client: Queryable,
  actor: AuditActor,
  entry: AuditEntryInput,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log
       (id, created_at, actor_user_id, actor_role, action, entity_type, entity_id, details)
     VALUES (gen_random_uuid(), clock_timestamp(), $1, $2, $3, $4, $5, $6::jsonb)`,
    [
      actor.userId,
      actor.role,
      entry.action,
      entry.entityType,
      entry.entityId,
      JSON.stringify(safeDetails(entry.entityType, entry.changes ?? null, entry.extra ?? null)),
    ],
  );
}
