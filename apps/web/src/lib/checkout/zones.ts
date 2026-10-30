import type { DeliveryZone, District, DistrictCode, Locale } from '@muniramarket/contracts';

export interface DistrictGroup {
  zone: DeliveryZone;
  districts: District[];
}

/** One group per active zone, with the districts that zone delivers to, in the API's order. */
export function districtGroups(zones: readonly DeliveryZone[]): DistrictGroup[] {
  return zones
    .filter((zone) => zone.districts.length > 0)
    .map((zone) => ({ zone, districts: zone.districts }));
}

/** The active zone that delivers to `code`, or `null` (the district is not deliverable). */
export function zoneForDistrict(
  zones: readonly DeliveryZone[],
  code: DistrictCode | '',
): DeliveryZone | null {
  if (code === '') return null;
  return zones.find((zone) => zone.districts.some((district) => district.code === code)) ?? null;
}

export function zoneName(zone: Pick<DeliveryZone, 'name_uz' | 'name_ru'>, locale: Locale): string {
  return locale === 'ru' ? zone.name_ru : zone.name_uz;
}

export function districtName(
  district: Pick<District, 'name_uz' | 'name_ru'>,
  locale: Locale,
): string {
  return locale === 'ru' ? district.name_ru : district.name_uz;
}

/** `09:00-21:00` with a real en dash, from the zone's `HH:MM` strings. */
export function zoneHours(zone: Pick<DeliveryZone, 'opens_at' | 'closes_at'>): string {
  return `${zone.opens_at}–${zone.closes_at}`;
}
