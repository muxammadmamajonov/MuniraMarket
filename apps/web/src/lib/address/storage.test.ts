import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from './address';
import {
  ADDRESS_STORAGE_ITEM,
  readDeliveryAddress,
  resetDeliveryAddressMemory,
  useDeliveryAddress,
  writeDeliveryAddress,
} from './storage';

const HOME: Address = {
  lat: 41.311081,
  lon: 69.240562,
  street: 'Amir Temur ko‘chasi',
  house: '15',
  apartment: '4',
  entrance: '',
  floor: '',
  landmark: 'Maktab yonida',
};

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetDeliveryAddressMemory();
});

describe('delivery address storage', () => {
  it('round-trips through localStorage under its versioned key', () => {
    expect(readDeliveryAddress()).toBeNull();
    expect(writeDeliveryAddress(HOME)).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(ADDRESS_STORAGE_ITEM) ?? 'null')).toEqual(HOME);
    resetDeliveryAddressMemory();
    expect(readDeliveryAddress()).toEqual(HOME);
  });

  it('forgets the address with null', () => {
    writeDeliveryAddress(HOME);
    writeDeliveryAddress(null);
    expect(window.localStorage.getItem(ADDRESS_STORAGE_ITEM)).toBeNull();
    expect(readDeliveryAddress()).toBeNull();
  });

  it.each([
    ['corrupt JSON', '{"lat": 41.3, '],
    ['a string', '"Amir Temur 15"'],
    ['no point', JSON.stringify({ ...HOME, lat: undefined })],
    ['an out-of-range point', JSON.stringify({ ...HOME, lon: 500 })],
  ])('ignores a stored value that does not parse: %s', (_name, raw) => {
    window.localStorage.setItem(ADDRESS_STORAGE_ITEM, raw);
    expect(readDeliveryAddress()).toBeNull();
  });

  it('keeps the address in memory for this page view when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(writeDeliveryAddress(HOME)).toBe(false);
    expect(readDeliveryAddress()).toEqual(HOME);
  });

  it('keeps the address in memory when localStorage itself is not accessible', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(writeDeliveryAddress(HOME)).toBe(false);
    expect(readDeliveryAddress()).toEqual(HOME);
  });
});

describe('useDeliveryAddress', () => {
  it('reads the stored address, is ready after hydration, and re-renders on save', () => {
    window.localStorage.setItem(ADDRESS_STORAGE_ITEM, JSON.stringify(HOME));
    const { result } = renderHook(() => useDeliveryAddress());
    expect(result.current[0]).toEqual(HOME);
    expect(result.current[2]).toBe(true);

    const next = { ...HOME, house: '17', apartment: '' };
    act(() => result.current[1](next));
    expect(result.current[0]).toEqual(next);
    expect(JSON.parse(window.localStorage.getItem(ADDRESS_STORAGE_ITEM) ?? 'null')).toEqual(next);
  });

  it('follows a change made in another tab (storage event)', () => {
    const { result } = renderHook(() => useDeliveryAddress());
    expect(result.current[0]).toBeNull();
    act(() => {
      window.localStorage.setItem(ADDRESS_STORAGE_ITEM, JSON.stringify(HOME));
      window.dispatchEvent(new StorageEvent('storage', { key: ADDRESS_STORAGE_ITEM }));
    });
    expect(result.current[0]).toEqual(HOME);
  });

  it('keeps one stable snapshot for an unchanged stored value', () => {
    window.localStorage.setItem(ADDRESS_STORAGE_ITEM, JSON.stringify(HOME));
    expect(readDeliveryAddress()).toBe(readDeliveryAddress());
  });
});
