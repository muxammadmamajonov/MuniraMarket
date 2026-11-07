/**
 * Tashkent delivery zones and pricing as pure, dependency-free functions (port of
 * services/api/app/domain/delivery.py).
 *
 * Zones are matched by district (no geocoding): every Tashkent district belongs to at most one
 * zone, and only active zones deliver. Money is integer UZS. Working hours are local
 * `Asia/Tashkent` time. Instants are epoch seconds (the app clock); times of day are seconds
 * since local midnight (PostgreSQL `time` values are parsed with `parseTimeOfDay`).
 */

/** Asia/Tashkent is UTC+05:00 all year (no daylight saving since 1992). */
export const TASHKENT_OFFSET_SECONDS = 5 * 60 * 60;
export const TASHKENT_TIMEZONE = 'Asia/Tashkent';
const DAY_SECONDS = 24 * 60 * 60;

export const DISTRICT_CODES = [
  'bektemir',
  'chilonzor',
  'mirobod',
  'mirzo_ulugbek',
  'olmazor',
  'sergeli',
  'shayxontohur',
  'uchtepa',
  'yakkasaroy',
  'yangihayot',
  'yashnobod',
  'yunusobod',
] as const;

export type DistrictCode = (typeof DISTRICT_CODES)[number];

export interface DistrictName {
  uz: string;
  ru: string;
}

/** The twelve districts (tumanlar) of Tashkent city, in the stable, documented order. */
export const DISTRICT_NAMES: Readonly<Record<DistrictCode, DistrictName>> = {
  bektemir: { uz: 'Bektemir', ru: 'Бектемирский' },
  chilonzor: { uz: 'Chilonzor', ru: 'Чиланзарский' },
  mirobod: { uz: 'Mirobod', ru: 'Мирабадский' },
  mirzo_ulugbek: { uz: 'Mirzo Ulug‘bek', ru: 'Мирзо-Улугбекский' },
  olmazor: { uz: 'Olmazor', ru: 'Алмазарский' },
  sergeli: { uz: 'Sergeli', ru: 'Сергелийский' },
  shayxontohur: { uz: 'Shayxontohur', ru: 'Шайхантахурский' },
  uchtepa: { uz: 'Uchtepa', ru: 'Учтепинский' },
  yakkasaroy: { uz: 'Yakkasaroy', ru: 'Яккасарайский' },
  yangihayot: { uz: 'Yangihayot', ru: 'Янгихаётский' },
  yashnobod: { uz: 'Yashnobod', ru: 'Яшнабадский' },
  yunusobod: { uz: 'Yunusobod', ru: 'Юнусабадский' },
};

export function isDistrictCode(value: string): value is DistrictCode {
  return Object.hasOwn(DISTRICT_NAMES, value);
}

/** The pricing and schedule facts of one zone. */
export interface ZoneRules {
  deliveryFeeUzs: number;
  /** `null`: delivery is never free in this zone. */
  freeDeliveryThresholdUzs: number | null;
  minOrderUzs: number;
  /** Local Asia/Tashkent time as `HH:MM[:SS[.ffffff]]`; `opensAt < closesAt`. */
  opensAt: string;
  closesAt: string;
}

/** What zone matching needs to know about a zone. */
export interface ZoneCandidate {
  isActive: boolean;
  districts: ReadonlySet<string>;
}

/** The active zone covering `district`, or `null` when no active zone delivers there. */
export function matchZone<Z extends ZoneCandidate>(
  district: string,
  zones: readonly Z[],
): Z | null {
  for (const zone of zones) {
    if (zone.isActive && zone.districts.has(district)) return zone;
  }
  return null;
}

/** Free once the subtotal reaches the zone's threshold, otherwise the zone's flat fee. */
export function deliveryFeeFor(rules: ZoneRules, subtotalUzs: number): number {
  const threshold = rules.freeDeliveryThresholdUzs;
  if (threshold !== null && subtotalUzs >= threshold) return 0;
  return rules.deliveryFeeUzs;
}

/** How much more to spend for free delivery; `0` once reached, `null` if never free. */
export function freeDeliveryRemaining(rules: ZoneRules, subtotalUzs: number): number | null {
  const threshold = rules.freeDeliveryThresholdUzs;
  if (threshold === null) return null;
  return Math.max(0, threshold - subtotalUzs);
}

/** `HH:MM[:SS[.ffffff]]` -> seconds since midnight (fraction kept). */
export function parseTimeOfDay(value: string): number {
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/.exec(value);
  if (!match) throw new RangeError('time of day must look like HH:MM[:SS[.ffffff]]');
  const [, hours, minutes, seconds = '0', fraction = ''] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(`0${fraction}`);
}

/** `HH:MM` of a PostgreSQL `time` value (seconds and fractions dropped, like `strftime`). */
export function hhmm(value: string): string {
  return value.slice(0, 5);
}

function tashkentSecondsOfDay(epochSeconds: number): number {
  const local = epochSeconds + TASHKENT_OFFSET_SECONDS;
  return ((local % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
}

/** Whether the instant falls within the zone's local opening hours. */
export function isOpenAt(rules: ZoneRules, epochSeconds: number): boolean {
  const local = tashkentSecondsOfDay(epochSeconds);
  return parseTimeOfDay(rules.opensAt) <= local && local < parseTimeOfDay(rules.closesAt);
}

/** The local (Asia/Tashkent) calendar date of an instant, as `YYYY-MM-DD`. */
export function tashkentDate(epochSeconds: number): string {
  const local = new Date(Math.floor((epochSeconds + TASHKENT_OFFSET_SECONDS) * 1000));
  return local.toISOString().slice(0, 10);
}

/** The instant (epoch seconds) of local wall-clock time `at` (`HH:MM[:SS]`) on `day`. */
export function tashkentInstant(day: string, at: string): number {
  const midnightUtc = Date.parse(`${day}T00:00:00Z`) / 1000;
  return midnightUtc + parseTimeOfDay(at) - TASHKENT_OFFSET_SECONDS;
}

/** A slot's order cutoff may not be later than the moment the slot starts. */
export function slotCutoffIsValid(slotDate: string, startsAt: string, cutoffAt: number): boolean {
  return cutoffAt <= tashkentInstant(slotDate, startsAt);
}
