import { matchPlace, type PlaceMatch } from '@/lib/delivery/district-match';
import { YANDEX_MAPS_GEOCODER_ORIGIN } from './config';
import type { LngLat } from './yandex-types';

/**
 * Reverse geocoding of one confirmed point with Yandex's Geocoder HTTP API, reduced to a
 * Tashkent district (see `district-match.ts`). The Maps JS API's `search` function needs a
 * **Search API** key, which is a different product; this deliberately uses our dedicated
 * Geocoder key instead.
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
  point: LngLat,
  { apiKey, timeoutMs = REVERSE_GEOCODE_TIMEOUT_MS }: { apiKey: string; timeoutMs?: number },
): Promise<PlaceMatch | null> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;

  const url = new URL('/v1', YANDEX_MAPS_GEOCODER_ORIGIN);
  url.searchParams.set('apikey', apiKey);
  url.searchParams.set('geocode', `${coordinate(point[0])},${coordinate(point[1])}`);
  url.searchParams.set('sco', 'longlat');
  url.searchParams.set('kind', 'district');
  // Uzbek is not a Geocoder API locale. The app remains Uzbek; Russian gives the most reliable
  // canonical district names, which `district-match.ts` understands.
  url.searchParams.set('lang', 'ru_RU');
  url.searchParams.set('format', 'json');

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const members = isFeatureMembers(body);
    if (members === null) return null;
    return matchPlace(
      members.map((member) => ({
        properties: {
          name: member.GeoObject.name,
          description: member.GeoObject.description,
        },
      })),
    );
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface GeocoderMember {
  GeoObject: { name: string; description: string };
}

function isFeatureMembers(value: unknown): GeocoderMember[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const response = (value as { response?: unknown }).response;
  if (typeof response !== 'object' || response === null) return null;
  const collection = (response as { GeoObjectCollection?: unknown }).GeoObjectCollection;
  if (typeof collection !== 'object' || collection === null) return null;
  const members = (collection as { featureMember?: unknown }).featureMember;
  if (!Array.isArray(members)) return null;
  const parsed: GeocoderMember[] = [];
  for (const member of members) {
    if (typeof member !== 'object' || member === null) continue;
    const object = (member as { GeoObject?: unknown }).GeoObject;
    if (typeof object !== 'object' || object === null) continue;
    const { name, description } = object as { name?: unknown; description?: unknown };
    if (typeof name === 'string' && typeof description === 'string') {
      parsed.push({ GeoObject: { name, description } });
    }
  }
  return parsed;
}
