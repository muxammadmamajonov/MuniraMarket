/** Parses an integer form field: `''` -> `null` (empty), a valid integer in range -> the number, anything else -> `'invalid'`. */
export function parseIntegerField(
  text: string,
  { min, max }: { min: number; max: number },
): number | null | 'invalid' {
  const trimmed = text.replace(/[\s ]/g, '');
  if (trimmed === '') return null;
  if (!/^-?\d{1,15}$/.test(trimmed)) return 'invalid';
  const value = Number(trimmed);
  return value >= min && value <= max ? value : 'invalid';
}
