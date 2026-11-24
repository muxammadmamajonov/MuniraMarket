import type { DeliveryAddress } from '@muniramarket/contracts';

/**
 * A delivery address: a map point (the courier's destination) plus what the courier needs at the
 * door. This is the one address shape of the storefront: the map picker edits it, the home card
 * and checkout show it, the order request is built from it, and saved addresses reuse it.
 *
 * Text parts are kept as typed (empty string = not given); {@link toAddressRequest} trims them and
 * drops the empty optional ones, as the Core API would.
 */
export interface Address {
  lat: number;
  lon: number;
  street: string;
  house: string;
  apartment: string;
  entrance: string;
  floor: string;
  landmark: string;
}

export type AddressTextField = Exclude<keyof Address, 'lat' | 'lon'>;

/** Length limits in characters, mirroring the Core API (`DeliveryAddress`). */
export const ADDRESS_LIMITS = {
  street: { min: 2, max: 200 },
  house: { min: 1, max: 32 },
  apartment: { min: 0, max: 16 },
  entrance: { min: 0, max: 16 },
  floor: { min: 0, max: 8 },
  landmark: { min: 0, max: 200 },
} as const satisfies Record<AddressTextField, { min: number; max: number }>;

export const ADDRESS_TEXT_FIELDS: readonly AddressTextField[] = [
  'street',
  'house',
  'apartment',
  'entrance',
  'floor',
  'landmark',
];

export type AddressErrorKind = 'required' | 'tooShort' | 'tooLong' | 'singleLine';

export interface AddressError {
  kind: AddressErrorKind;
  /** For `tooShort` / `tooLong`. */
  limit?: number;
}

export type AddressErrors = Partial<Record<AddressTextField, AddressError>>;

/** A valid WGS84 point (finite, latitude within ±90, longitude within ±180). */
export function isValidPoint(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  );
}

/** ~10 cm. More digits add nothing for a courier and only make the stored value noisier. */
export function roundCoordinate(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function chars(text: string): number {
  return Array.from(text).length;
}

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Field errors of the text parts. Empty when the address can be sent. */
export function validateAddress(address: Address): AddressErrors {
  const errors: AddressErrors = {};
  for (const field of ADDRESS_TEXT_FIELDS) {
    const { min, max } = ADDRESS_LIMITS[field];
    const value = address[field].trim();
    const length = chars(value);
    if (length === 0 && min > 0) errors[field] = { kind: 'required' };
    else if (length > 0 && length < min) errors[field] = { kind: 'tooShort', limit: min };
    else if (length > max) errors[field] = { kind: 'tooLong', limit: max };
    else if (hasControlCharacter(value)) errors[field] = { kind: 'singleLine' };
  }
  return errors;
}

/** Whether the address is complete and valid (point and text). */
export function isCompleteAddress(address: Address | null): address is Address {
  return (
    address !== null &&
    isValidPoint(address.lat, address.lon) &&
    Object.keys(validateAddress(address)).length === 0
  );
}

/** The `address` of `POST /orders`. Keys in a fixed order (the idempotency fingerprint). */
export function toAddressRequest(address: Address): DeliveryAddress {
  const optional = (raw: string) => {
    const value = raw.trim();
    return value === '' ? undefined : value;
  };
  const apartment = optional(address.apartment);
  const entrance = optional(address.entrance);
  const floor = optional(address.floor);
  const landmark = optional(address.landmark);
  return {
    lat: roundCoordinate(address.lat),
    lon: roundCoordinate(address.lon),
    street: address.street.trim(),
    house: address.house.trim(),
    ...(apartment === undefined ? {} : { apartment }),
    ...(entrance === undefined ? {} : { entrance }),
    ...(floor === undefined ? {} : { floor }),
    ...(landmark === undefined ? {} : { landmark }),
  };
}

/** Wording of the short parts of an address line (from the dictionary). `{value}` placeholders. */
export interface AddressLineWords {
  apartmentShort: string;
  entranceShort: string;
  floorShort: string;
}

/**
 * The address on one line, for example "Amir Temur ko‘chasi, 15, 4-xonadon, 2-podyezd". The
 * landmark is not part of it (it is a note, shown separately where there is room).
 */
export function formatAddressLine(
  address: Pick<Address, 'street' | 'house' | 'apartment' | 'entrance' | 'floor'>,
  words: AddressLineWords,
): string {
  const part = (template: string, value: string) => template.replace('{value}', value.trim());
  return [
    address.street.trim(),
    address.house.trim(),
    address.apartment.trim() === '' ? '' : part(words.apartmentShort, address.apartment),
    address.entrance.trim() === '' ? '' : part(words.entranceShort, address.entrance),
    address.floor.trim() === '' ? '' : part(words.floorShort, address.floor),
  ]
    .filter((piece) => piece !== '')
    .join(', ');
}

/** Parses an untrusted value (storage, URL state) into an {@link Address}, or `null`. */
export function parseAddress(value: unknown): Address | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!isValidPoint(record.lat, record.lon)) return null;
  const text = (key: AddressTextField): string | null => {
    const raw = record[key];
    if (raw === undefined || raw === null) return '';
    return typeof raw === 'string' ? raw.slice(0, ADDRESS_LIMITS[key].max * 2) : null;
  };
  const parts = Object.fromEntries(ADDRESS_TEXT_FIELDS.map((key) => [key, text(key)])) as Record<
    AddressTextField,
    string | null
  >;
  if (Object.values(parts).some((part) => part === null)) return null;
  return {
    lat: record.lat as number,
    lon: record.lon as number,
    street: parts.street ?? '',
    house: parts.house ?? '',
    apartment: parts.apartment ?? '',
    entrance: parts.entrance ?? '',
    floor: parts.floor ?? '',
    landmark: parts.landmark ?? '',
  };
}
