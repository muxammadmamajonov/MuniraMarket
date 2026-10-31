/** Helpers for list screens whose filters and page live in the URL. */

export const LIST_PAGE_SIZE = 20;

export function parsePageParam(value: string | null): number {
  const page = Number(value);
  return Number.isSafeInteger(page) && page >= 1 && page <= 100000 ? page : 1;
}

export function parseChoice<T extends string>(
  value: string | null,
  allowed: readonly T[],
): T | null {
  return allowed.includes(value as T) ? (value as T) : null;
}

export function parseText(value: string | null, max = 100): string {
  return (value ?? '').trim().slice(0, max);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null): value is string {
  return value !== null && UUID.test(value);
}

/** Builds `?a=1&b=2` leaving out empty values and `page=1`. */
export function queryString(values: Record<string, string | number | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === '') continue;
    if (key === 'page' && Number(value) <= 1) continue;
    query.set(key, String(value));
  }
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}
