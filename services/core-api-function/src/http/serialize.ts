/**
 * JSON values in the same shape Pydantic v2 (the FastAPI reference) emits.
 *
 * Datetimes: UTC ISO 8601 with a `Z` suffix and fractional seconds only when non-zero
 * (`2026-11-07T10:00:00Z`, `2026-11-07T10:00:00.123000Z`). Postgres keeps microseconds; `pg`
 * returns milliseconds, so prefer selecting timestamps already formatted with `isoSql()` where
 * microsecond fidelity matters (idempotent replays compare stored values, not strings).
 */
export function isoDateTime(value: Date | null): string | null {
  if (value === null) return null;
  const iso = value.toISOString(); // 2026-11-07T10:00:00.123Z
  const [base, fraction = '000Z'] = iso.split('.');
  const millis = fraction.replace('Z', '');
  return millis === '000' ? `${base}Z` : `${base}.${millis}000Z`;
}

/**
 * SQL expression that renders a `timestamptz` column exactly like Pydantic (microseconds kept,
 * trailing `.000000` dropped): use as `${isoSql('o.created_at')} AS created_at`.
 */
export function isoSql(column: string): string {
  return (
    `regexp_replace(to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), ` +
    `'\\.000000$', '') || 'Z'`
  );
}
