/**
 * Invisible and direction-changing characters in names and descriptions (port of
 * services/api/app/domain/text.py).
 *
 * Unicode *format* characters (`Cf`: bidi overrides such as U+202E, zero-width spaces such as
 * U+200B, the BOM U+FEFF, the soft hyphen, ...) render as nothing but change how surrounding text
 * is displayed or compared, so they are refused wherever catalog names are written (JSON API and
 * CSV import). Descriptions keep newlines and tabs but refuse the same characters. Lone
 * surrogates (`Cs`) cannot be stored as UTF-8; single-line text also refuses the line/paragraph
 * separators (`Zl`/`Zp`) and a few invisible "filler" letters.
 */

const REFUSED = /[\p{Cf}\p{Cs}]/u;
const REFUSED_SINGLE_LINE = /[\p{Zl}\p{Zp}]/u;
// Hangul fillers, combining grapheme joiner, Khmer inherent vowels, halfwidth Hangul filler.
const INVISIBLE_FILLERS = new RegExp(
  '\\u034f|\\u115f|\\u1160|\\u17b4|\\u17b5|\\u3164|\\uffa0',
  'u',
);

export const INVISIBLE_TEXT_MESSAGE =
  'must not contain invisible or text-direction characters (e.g. U+200B, U+202E, U+FEFF)';

/** Whether `value` contains a character refused in names (`multiline`: descriptions). */
export function hasInvisibleCharacters(
  value: string,
  options: { multiline?: boolean } = {},
): boolean {
  if (INVISIBLE_FILLERS.test(value) || REFUSED.test(value)) return true;
  return !options.multiline && REFUSED_SINGLE_LINE.test(value);
}

// Python `str.isspace()` characters (JS `trim()` differs: it strips U+FEFF but not U+001C-U+001F).
const PY_WHITESPACE =
  '\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_STRIP = new RegExp(`^[${PY_WHITESPACE}]+|[${PY_WHITESPACE}]+$`, 'g');

/** Python `str.strip()` with no argument (Pydantic `strip_whitespace` uses it too). */
export function pyStrip(value: string): string {
  return value.replace(PY_STRIP, '');
}

/** Python `len(str)`: code points, not UTF-16 units. */
export function pyLen(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}
