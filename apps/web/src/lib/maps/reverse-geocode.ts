import { matchPlace, type PlaceMatch } from '@/lib/delivery/district-match';
import type { LngLat, YMaps3 } from './yandex-types';

/**
 * Reverse geocoding of one confirmed point with the Yandex Maps JS API v3 geosearch
 * (`ymaps3.search`, toponyms only), reduced to a Tashkent district (see `district-match.ts`).
 *
 * Returns `null` whenever the lookup itself is unavailable: no `search` in this SDK, a key
 * without the Search API (403), quota exhausted, offline, a CSP block or a timeout. The caller
 * must then not claim anything about delivery and must ask for the district instead.
 *
 * Privacy: the point goes only to Yandex, in this one request. It is never logged (errors are
 * swallowed without their message, which could echo the request), stored or sent to our API.
 */

export const REVERSE_GEOCODE_TIMEOUT_MS = 8000;

/** ~10 cm; more digits add nothing to a district lookup. */
function coordinate(value: number): string {
  return value.toFixed(6);
}

export async function reverseGeocodeDistrict(
  api: YMaps3,
  point: LngLat,
  { apiKey, timeoutMs = REVERSE_GEOCODE_TIMEOUT_MS }: { apiKey: string; timeoutMs?: number },
): Promise<PlaceMatch | null> {
  const search = api.search;
  if (typeof search !== 'function') return null;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The v3 reference requires a Search API key to be set before `search`; we use the one key
    // we have. If Yandex does not enable geosearch for it, the request fails and we fall back.
    api.getDefaultConfig?.().setApikeys({ search: apiKey });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    });
    const features = await Promise.race([
      search({
        text: `${coordinate(point[0])},${coordinate(point[1])}`,
        type: ['toponyms'],
        limit: 10,
      }),
      timeout,
    ]);
    if (!Array.isArray(features)) return null;
    return matchPlace(features);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
