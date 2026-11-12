import type { SavedAddress, SavedAddressRequest } from '@muniramarket/contracts';
import {
  formatAddressLine,
  toAddressRequest,
  type Address,
  type AddressLineWords,
} from './address';

/**
 * Saved addresses (`/me/addresses`) are the same {@link Address} shape plus a name and the
 * "default" flag; these helpers convert between the API and the storefront form.
 */

/** Optional label length (characters), mirroring the Core API. */
export const ADDRESS_LABEL_MAX = 32;

export function savedToAddress(saved: SavedAddress): Address {
  return {
    lat: saved.lat,
    lon: saved.lon,
    street: saved.street,
    house: saved.house,
    apartment: saved.apartment ?? '',
    entrance: saved.entrance ?? '',
    floor: saved.floor ?? '',
    landmark: saved.landmark ?? '',
  };
}

export function toSavedAddressRequest(
  address: Address,
  options: { label: string; isDefault?: boolean | undefined },
): SavedAddressRequest {
  const label = options.label.trim();
  return {
    ...toAddressRequest(address),
    label: label === '' ? null : label,
    ...(options.isDefault === undefined ? {} : { is_default: options.isDefault }),
  };
}

/** The row title: the label, else the street line. */
export function savedAddressTitle(saved: SavedAddress, words: AddressLineWords): string {
  const label = saved.label?.trim() ?? '';
  return label !== '' ? label : formatAddressLine(savedToAddress(saved), words);
}

/** Two addresses point at the same door (same point to ~1 m and the same text parts). */
export function sameAddress(a: Address, b: Address): boolean {
  const close = (x: number, y: number) => Math.abs(x - y) < 1e-5;
  const norm = (value: string) => value.trim().toLocaleLowerCase();
  return (
    close(a.lat, b.lat) &&
    close(a.lon, b.lon) &&
    (['street', 'house', 'apartment', 'entrance', 'floor'] as const).every(
      (key) => norm(a[key]) === norm(b[key]),
    )
  );
}
