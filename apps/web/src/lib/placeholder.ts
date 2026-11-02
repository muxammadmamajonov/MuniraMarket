/**
 * Deterministic look for products and categories without a photo. The same key always gives the
 * same tint, so a category reads as one family and nothing shuffles between renders or between
 * server and client.
 */

/** Number of `.mm-tone-N` tints defined in `app/globals.css`. */
export const TONE_COUNT = 8;

/** FNV-1a: tiny, stable across runtimes, spreads similar UUIDs well enough for eight buckets. */
export function toneFor(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % TONE_COUNT;
}

/** First letter or digit of a name, upper-cased (`olma` -> `O`); a dot when there is none. */
export function initialOf(name: string): string {
  for (const char of name.trim()) {
    if (/[\p{L}\p{N}]/u.test(char)) return char.toLocaleUpperCase();
  }
  return '·';
}
