import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DISTRICT_STORAGE_ITEM,
  readDistrictPreference,
  resetDistrictPreferenceMemory,
  useDistrictPreference,
  writeDistrictPreference,
} from './district-preference';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetDistrictPreferenceMemory();
});

describe('district preference', () => {
  it('stores only the district code under one key', () => {
    expect(writeDistrictPreference('chilonzor')).toBe(true);
    expect(window.localStorage.getItem(DISTRICT_STORAGE_ITEM)).toBe('chilonzor');
    expect(Object.keys(window.localStorage)).toEqual([DISTRICT_STORAGE_ITEM]);
    expect(readDistrictPreference()).toBe('chilonzor');
  });

  it('forgets the choice with null', () => {
    writeDistrictPreference('sergeli');
    writeDistrictPreference(null);
    expect(window.localStorage.getItem(DISTRICT_STORAGE_ITEM)).toBeNull();
    expect(readDistrictPreference()).toBeNull();
  });

  it.each(['Chilonzor', 'tashkent', '', '{"code":"chilonzor"}', '+998901234567'])(
    'ignores a stored value that is not a known district code (%j)',
    (value) => {
      window.localStorage.setItem(DISTRICT_STORAGE_ITEM, value);
      expect(readDistrictPreference()).toBeNull();
    },
  );

  it('falls back to memory for this page view when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(readDistrictPreference()).toBeNull();
    const { result } = renderHook(() => useDistrictPreference());
    expect(result.current[0]).toBeNull();
    act(() => result.current[1]('yunusobod'));
    expect(result.current[0]).toBe('yunusobod');
  });

  it('follows changes made in this tab and in other tabs', () => {
    const { result } = renderHook(() => useDistrictPreference());
    expect(result.current[2]).toBe(true);
    act(() => result.current[1]('mirobod'));
    expect(result.current[0]).toBe('mirobod');

    act(() => {
      window.localStorage.setItem(DISTRICT_STORAGE_ITEM, 'olmazor');
      window.dispatchEvent(new StorageEvent('storage', { key: DISTRICT_STORAGE_ITEM }));
    });
    expect(result.current[0]).toBe('olmazor');
  });
});
