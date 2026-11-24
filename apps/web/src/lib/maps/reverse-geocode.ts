import { YANDEX_MAPS_GEOCODER_ORIGIN } from './config';
import type { LngLat } from './yandex-types';

/**
 * Reverse geocoding of the map pin with Yandex's Geocoder HTTP API, reduced to the two parts a
 * courier needs: street and house. The picker fills its form with them so the customer mostly
 * just confirms. The Maps JS API's `search` needs a separate **Search API** key; this uses our
 * dedicated Geocoder key instead.
 *
 * Returns `null` whenever the lookup is unavailable or found nothing usable: no key, a key without
 * the Geocoder product (403), quota exhausted, offline, a CSP block or a timeout. The customer then
 * types the street and house themselves; the pin is still the delivery point.
 *
 * Privacy: the point goes to Yandex in this request and to our API only inside the order. It is
 * never logged (errors are swallowed without their message, which could echo the request).
 */

export const REVERSE_GEOCODE_TIMEOUT_MS = 8000;

export interface GeocodedAddress {
  /** Street (or, without one, the neighbourhood such as a "kvartal"). `''` when unknown. */
  street: string;
  /** House number. `''` when unknown. */
  house: string;
}

/** ~10 cm; more digits add nothing. */
function coordinate(value: number): string {
  return value.toFixed(6);
}

export async function reverseGeocodeAddress(
  point: LngLat,
  { apiKey, timeoutMs = REVERSE_GEOCODE_TIMEOUT_MS }: { apiKey: string; timeoutMs?: number },
): Promise<GeocodedAddress | null> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;

  const url = new URL('/v1', YANDEX_MAPS_GEOCODER_ORIGIN);
  url.searchParams.set('apikey', apiKey);
  url.searchParams.set('geocode', `${coordinate(point[0])},${coordinate(point[1])}`);
  url.searchParams.set('sco', 'longlat');
  // The nearest building: its components carry both the street and the house number.
  url.searchParams.set('kind', 'house');
  url.searchParams.set('results', '1');
  // Uzbek is not a Geocoder API locale; Russian gives the most complete Tashkent street names.
  url.searchParams.set('lang', 'ru_RU');
  url.searchParams.set('format', 'json');

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const found = firstResult(body);
    return found === null ? null : addressFromResult(found);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface AddressComponent {
  kind: string;
  name: string;
}

export interface GeocoderResult {
  /** The result's own name, e.g. "улица Бунёдкор, 15" or "9-й квартал, 5". */
  name: string;
  /** Address components, most general first. */
  components: AddressComponent[];
}

/**
 * Street and house from the nearest-house result. Without a `street` component (Tashkent
 * "kvartal" and "massiv" addresses such as "9-й квартал, 5") the result's name, minus its house
 * number, stands in for the street, as that is how such addresses are written.
 */
export function addressFromResult({ name, components }: GeocoderResult): GeocodedAddress | null {
  const last = (kind: string) =>
    [...components]
      .reverse()
      .find((component) => component.kind === kind)
      ?.name.trim() ?? '';
  const house = last('house');
  let street = last('street');
  if (street === '') {
    const suffix = house === '' ? '' : `, ${house}`;
    const trimmed = name.trim();
    street = suffix !== '' && trimmed.endsWith(suffix) ? trimmed.slice(0, -suffix.length) : '';
  }
  if (street === '' && house === '') return null;
  return { street, house };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function firstResult(body: unknown): GeocoderResult | null {
  const members = record(record(record(body)?.response)?.GeoObjectCollection)?.featureMember;
  if (!Array.isArray(members) || members.length === 0) return null;
  const geoObject = record(record(members[0])?.GeoObject);
  const meta = record(record(geoObject?.metaDataProperty)?.GeocoderMetaData);
  const raw = record(meta?.Address)?.Components;
  if (!Array.isArray(raw)) return null;
  const components: AddressComponent[] = [];
  for (const item of raw) {
    const component = record(item);
    if (typeof component?.kind === 'string' && typeof component.name === 'string') {
      components.push({ kind: component.kind, name: component.name });
    }
  }
  const name = typeof geoObject?.name === 'string' ? geoObject.name : '';
  return { name, components };
}
