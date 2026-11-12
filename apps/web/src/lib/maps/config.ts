/**
 * Yandex Maps JavaScript API configuration.
 *
 * The two keys come from runtime Worker secrets (one build works for every environment, as with
 * `API_INTERNAL_URL`). The JavaScript API key loads the map, while the Geocoder key authorizes
 * the one reverse-geocoding lookup after the customer confirms a point. Both reach the browser,
 * so Yandex protects them by HTTP Referer restriction, not by secrecy. They are never committed;
 * `.env.example` holds empty values.
 *
 * Not `server-only`: `src/proxy.ts` reads it too, to decide whether the CSP allows the Yandex
 * hosts at all. Without a valid key the map is never loaded and the CSP stays as before.
 */

/** The official JavaScript API host. The only host the app loads map code from. */
export const YANDEX_MAPS_API_ORIGIN = 'https://api-maps.yandex.ru';

/** Tiles, vector data and styles the API fetches once loaded. */
export const YANDEX_MAPS_DATA_ORIGIN = 'https://*.maps.yandex.net';

/** Stylesheet assets loaded by the official JavaScript API after its bootstrap script runs. */
export const YANDEX_MAPS_STATIC_ORIGIN = 'https://yastatic.net';

/** Geosearch host `ymaps3.search` calls (reverse geocoding), per the v3 CSP requirements. */
export const YANDEX_MAPS_SEARCH_ORIGIN = 'https://search-maps.yandex.ru';

/**
 * Yandex issues both legacy UUID keys and newer compact JavaScript API keys. The key reaches the
 * browser as a URL query parameter, so accept only a conservative token alphabet (including
 * base64 padding) and reject whitespace, quotes and markup rather than tying the app to one
 * issuance format.
 */
const KEY_PATTERN = /^[A-Za-z0-9_=\-]{20,128}$/;

function readYandexMapsKey(
  name: 'YANDEX_MAPS_JAVASCRIPT_API_KEY' | 'YANDEX_MAPS_GEOCODER_API_KEY',
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const raw = env[name]?.trim();
  return raw !== undefined && KEY_PATTERN.test(raw) ? raw : null;
}

export function readYandexMapsJavaScriptApiKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  return readYandexMapsKey('YANDEX_MAPS_JAVASCRIPT_API_KEY', env);
}

export function readYandexMapsGeocoderApiKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  return readYandexMapsKey('YANDEX_MAPS_GEOCODER_API_KEY', env);
}
