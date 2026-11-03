/**
 * Yandex Maps JavaScript API configuration.
 *
 * The key comes from `YANDEX_MAPS_API_KEY`, read at runtime on the server (one build works for
 * every environment, as with `API_INTERNAL_URL`). Unlike the server-only settings in
 * `lib/config.ts`, this one does reach the browser: the JavaScript API is loaded with the key in
 * its script URL, so Yandex protects it by an HTTP Referer restriction set in the Yandex developer
 * console, not by secrecy. It is still never committed; `.env.example` holds an empty value.
 *
 * Not `server-only`: `src/proxy.ts` reads it too, to decide whether the CSP allows the Yandex
 * hosts at all. Without a valid key the map is never loaded and the CSP stays as before.
 */

/** The official JavaScript API host. The only host the app loads map code from. */
export const YANDEX_MAPS_API_ORIGIN = 'https://api-maps.yandex.ru';

/** Tiles, vector data and styles the API fetches once loaded. */
export const YANDEX_MAPS_DATA_ORIGIN = 'https://*.maps.yandex.net';

/** Yandex developer keys are UUIDs; anything else is a misconfiguration and disables the map. */
const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readYandexMapsApiKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const raw = env['YANDEX_MAPS_API_KEY']?.trim();
  return raw !== undefined && KEY_PATTERN.test(raw) ? raw : null;
}
