export interface DetailLine {
  /** Field or context key. */
  key: string;
  /** `from` is `undefined` for plain context (`rows: 12`), a value (maybe `null`) for a change. */
  from?: string | number | boolean | null;
  to: string | number | boolean | null;
  change: boolean;
}

type Scalar = string | number | boolean | null;
const isScalar = (value: unknown): value is Scalar =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

/**
 * Flattens an audit entry's `details` (`{ changes: { field: { from, to } }, ...context }`) into
 * lines for display. Anything that is not a scalar is skipped, so an unexpected shape cannot
 * render `[object Object]` (the API only stores scalars here anyway).
 */
export function auditDetailLines(details: Record<string, unknown>): DetailLine[] {
  const lines: DetailLine[] = [];
  const changes = details['changes'];
  if (typeof changes === 'object' && changes !== null && !Array.isArray(changes)) {
    for (const [key, value] of Object.entries(changes as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const { from, to } = value as { from?: unknown; to?: unknown };
      if (isScalar(from) && isScalar(to)) lines.push({ key, from, to, change: true });
    }
  }
  for (const [key, value] of Object.entries(details)) {
    if (key === 'changes' || !isScalar(value)) continue;
    lines.push({ key, to: value, change: false });
  }
  return lines;
}
