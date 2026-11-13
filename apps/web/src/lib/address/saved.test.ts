import { describe, expect, it } from 'vitest';
import { getDictionary } from '@/i18n';
import type { Address } from './address';
import { sameAddress, savedAddressTitle, savedToAddress, toSavedAddressRequest } from './saved';

const SAVED = {
  id: 'a1',
  label: null,
  lat: 41.3,
  lon: 69.2,
  street: 'Navoiy ko‘chasi',
  house: '30',
  apartment: null,
  entrance: '2',
  floor: null,
  landmark: null,
  is_default: true,
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
};

describe('saved addresses', () => {
  it('converts to the storefront address and back to a request', () => {
    const address = savedToAddress(SAVED);
    expect(address).toEqual({
      lat: 41.3,
      lon: 69.2,
      street: 'Navoiy ko‘chasi',
      house: '30',
      apartment: '',
      entrance: '2',
      floor: '',
      landmark: '',
    });
    expect(toSavedAddressRequest(address, { label: '  Uy ', isDefault: true })).toEqual({
      lat: 41.3,
      lon: 69.2,
      street: 'Navoiy ko‘chasi',
      house: '30',
      entrance: '2',
      label: 'Uy',
      is_default: true,
    });
    expect(toSavedAddressRequest(address, { label: ' ' })).not.toHaveProperty('is_default');
    expect(toSavedAddressRequest(address, { label: ' ' }).label).toBeNull();
  });

  it('titles a row by its label, else its street line', () => {
    const words = getDictionary('uz').address;
    expect(savedAddressTitle(SAVED, words)).toBe('Navoiy ko‘chasi, 30, 2-podyezd');
    expect(savedAddressTitle({ ...SAVED, label: 'Ish' }, words)).toBe('Ish');
  });

  it('recognises the same door (case, spaces, tiny coordinate noise)', () => {
    const a: Address = savedToAddress(SAVED);
    expect(sameAddress(a, { ...a, street: ' navoiy KO‘CHASI ', lat: 41.300001 })).toBe(true);
    expect(sameAddress(a, { ...a, house: '31' })).toBe(false);
    expect(sameAddress(a, { ...a, lat: 41.31 })).toBe(false);
  });
});
