import type { DeliveryZone, District, DistrictCode } from '@muniramarket/contracts';
import { findServedDistrict } from '@/lib/checkout/zones';
import { DISTRICT_NEIGHBOURS } from './districts';
import type { PlaceMatch } from './district-match';

/**
 * What the map can honestly say about a confirmed point, given the live zones:
 *
 * - `served`: the point is in a district an active zone delivers to (with that zone's rules);
 * - `not-served`: we know the district, and no active zone covers it (with served neighbours);
 * - `outside`: the point is not in Tashkent city;
 * - `unknown`: the lookup worked but did not name a district; the customer picks from the list;
 * - `lookup-failed`: reverse geocoding was unavailable (key, quota, network, offline...).
 *
 * Only `served` ever says "we deliver here", and only because the zones API says so.
 */
export type Coverage =
  | { status: 'served'; zone: DeliveryZone; district: District }
  | { status: 'not-served'; code: DistrictCode; nearby: District[] }
  | { status: 'outside' }
  | { status: 'unknown' }
  | { status: 'lookup-failed' };

/** Generous bounding box of Tashkent city, `[lng, lat]`. Used only to avoid a false "outside". */
const CITY_BOUNDS = { west: 69.1, east: 69.5, south: 41.15, north: 41.45 } as const;

export function isNearTashkent([lng, lat]: readonly [number, number]): boolean {
  return (
    lng >= CITY_BOUNDS.west &&
    lng <= CITY_BOUNDS.east &&
    lat >= CITY_BOUNDS.south &&
    lat <= CITY_BOUNDS.north
  );
}

/** Up to `limit` served districts bordering `code`, falling back to any served district. */
export function servedNeighbours(
  zones: readonly DeliveryZone[],
  code: DistrictCode,
  limit = 3,
): District[] {
  const out: District[] = [];
  const add = (candidate: DistrictCode) => {
    if (out.length >= limit || candidate === code) return;
    if (out.some((district) => district.code === candidate)) return;
    const served = findServedDistrict(zones, candidate);
    if (served !== null) out.push(served.district);
  };
  for (const neighbour of DISTRICT_NEIGHBOURS[code]) add(neighbour);
  for (const zone of zones) for (const district of zone.districts) add(district.code);
  return out;
}

export function coverageFor(
  zones: readonly DeliveryZone[],
  match: PlaceMatch | null,
  point: readonly [number, number],
): Coverage {
  if (match === null) return { status: 'lookup-failed' };
  switch (match.kind) {
    case 'district': {
      const served = findServedDistrict(zones, match.code);
      if (served !== null) return { status: 'served', ...served };
      return {
        status: 'not-served',
        code: match.code,
        nearby: servedNeighbours(zones, match.code),
      };
    }
    case 'elsewhere':
      // Results that never mention Tashkent, for a point well away from it: honestly outside.
      // Inside the city's box we would rather ask than turn a customer away.
      return isNearTashkent(point) ? { status: 'unknown' } : { status: 'outside' };
    case 'city':
    case 'nothing':
      return { status: 'unknown' };
  }
}

/** Seeded demo zones have `demo-` slugs (see the README's "Demo data"). */
export function isDemoZone(zone: Pick<DeliveryZone, 'slug'>): boolean {
  return zone.slug.startsWith('demo-');
}
