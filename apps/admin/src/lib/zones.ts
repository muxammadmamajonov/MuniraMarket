import type {
  DeliveryZoneAdmin,
  DistrictCode,
  ZoneCreateRequest,
  ZoneUpdateRequest,
} from '@muniramarket/contracts';
import type { FieldKey } from '@/i18n/dictionaries/sections/shared';
import { parseIntegerField } from './numbers';
import { SLUG_PATTERN } from './slug';
import { isHHMM, toHHMM } from './time';

const MAX_MONEY = 1_000_000_000_000;

export interface ZoneFormValues {
  slug: string;
  name_uz: string;
  name_ru: string;
  fee: string;
  free_threshold: string;
  min_order: string;
  opens_at: string;
  closes_at: string;
  sort_order: string;
  is_active: boolean;
  districts: DistrictCode[];
}

export type ZoneProblems = Partial<Record<FieldKey, 'required' | 'invalid'>>;

export function emptyZoneForm(): ZoneFormValues {
  return {
    slug: '',
    name_uz: '',
    name_ru: '',
    fee: '',
    free_threshold: '',
    min_order: '0',
    opens_at: '09:00',
    closes_at: '21:00',
    sort_order: '0',
    is_active: true,
    districts: [],
  };
}

export function zoneToForm(zone: DeliveryZoneAdmin): ZoneFormValues {
  return {
    slug: zone.slug,
    name_uz: zone.name_uz,
    name_ru: zone.name_ru,
    fee: String(zone.delivery_fee_uzs),
    free_threshold:
      zone.free_delivery_threshold_uzs === null ? '' : String(zone.free_delivery_threshold_uzs),
    min_order: String(zone.min_order_uzs),
    opens_at: toHHMM(zone.opens_at),
    closes_at: toHHMM(zone.closes_at),
    sort_order: String(zone.sort_order),
    is_active: zone.is_active,
    districts: zone.districts.map((district) => district.code as DistrictCode),
  };
}

export function validateZone(values: ZoneFormValues): ZoneProblems {
  const problems: ZoneProblems = {};
  for (const key of ['name_uz', 'name_ru'] as const) {
    const text = values[key].trim();
    if (text === '') problems[key] = 'required';
    else if (text.length > 255) problems[key] = 'invalid';
  }
  if (values.slug.trim() === '') problems.slug = 'required';
  else if (!SLUG_PATTERN.test(values.slug.trim()) || values.slug.trim().length > 64) {
    problems.slug = 'invalid';
  }
  const money = (text: string, key: FieldKey, optional: boolean) => {
    const parsed = parseIntegerField(text, { min: 0, max: MAX_MONEY });
    if (parsed === 'invalid') problems[key] = 'invalid';
    else if (parsed === null && !optional) problems[key] = 'required';
  };
  money(values.fee, 'delivery_fee_uzs', false);
  money(values.free_threshold, 'free_delivery_threshold_uzs', true);
  money(values.min_order, 'min_order_uzs', false);

  if (!isHHMM(values.opens_at)) problems.opens_at = values.opens_at === '' ? 'required' : 'invalid';
  if (!isHHMM(values.closes_at))
    problems.closes_at = values.closes_at === '' ? 'required' : 'invalid';
  else if (isHHMM(values.opens_at) && values.closes_at <= values.opens_at) {
    problems.closes_at = 'invalid';
  }
  const sort = parseIntegerField(values.sort_order, { min: -100000, max: 100000 });
  if (typeof sort !== 'number') problems.sort_order = sort === null ? 'required' : 'invalid';
  if (values.districts.length === 0) problems.districts = 'required';
  return problems;
}

const int = (text: string): number => {
  const parsed = parseIntegerField(text, { min: -MAX_MONEY, max: MAX_MONEY });
  return typeof parsed === 'number' ? parsed : 0;
};

export function buildZoneCreate(values: ZoneFormValues): ZoneCreateRequest {
  const free = parseIntegerField(values.free_threshold, { min: 0, max: MAX_MONEY });
  return {
    slug: values.slug.trim(),
    name_uz: values.name_uz.trim(),
    name_ru: values.name_ru.trim(),
    delivery_fee_uzs: int(values.fee),
    free_delivery_threshold_uzs: typeof free === 'number' ? free : null,
    min_order_uzs: int(values.min_order),
    opens_at: values.opens_at,
    closes_at: values.closes_at,
    sort_order: int(values.sort_order),
    is_active: values.is_active,
    districts: [...values.districts],
  };
}

/** Only what differs from the stored zone (the API changes exactly the fields it receives). */
export function buildZoneUpdate(
  values: ZoneFormValues,
  zone: DeliveryZoneAdmin,
): ZoneUpdateRequest {
  const next = buildZoneCreate(values);
  const before = buildZoneCreate(zoneToForm(zone));
  const changes: Record<string, unknown> = {};
  for (const key of Object.keys(next) as Array<keyof ZoneCreateRequest>) {
    const a = next[key];
    const b = before[key];
    const same =
      key === 'districts'
        ? [...(a as string[])].sort().join() === [...(b as string[])].sort().join()
        : a === b;
    if (!same) changes[key] = a;
  }
  return changes as ZoneUpdateRequest;
}
