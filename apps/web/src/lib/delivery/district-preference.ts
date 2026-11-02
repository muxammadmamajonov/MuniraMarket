'use client';

import { isDistrictCode, type DistrictCode } from '@muniramarket/contracts';
import { useCallback, useSyncExternalStore } from 'react';

/**
 * The storefront's one remembered delivery choice: the Tashkent district code (for example
 * `chilonzor`). It is not personal data: no address, phone, name, session or checkout details are
 * ever written here, only one of the twelve public district codes.
 *
 * Storage can be missing or throw (private mode, blocked site data, a Telegram WebView with
 * storage disabled), so every access is guarded and the app behaves as "no district chosen". A
 * stored value that is not a known district code is ignored, never trusted.
 */

export const DISTRICT_STORAGE_ITEM = 'mm.delivery-district.v1';

/** Same-tab change notification; `storage` events only reach other tabs. */
const CHANGE_EVENT = 'mm:delivery-district';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readDistrictPreference(): DistrictCode | null {
  try {
    const value = storage()?.getItem(DISTRICT_STORAGE_ITEM) ?? null;
    return isDistrictCode(value) ? value : null;
  } catch {
    return null;
  }
}

/** Saves `code` (or forgets the choice with `null`). Returns whether storage accepted it. */
export function writeDistrictPreference(code: DistrictCode | null): boolean {
  let saved = false;
  try {
    const store = storage();
    if (store !== null) {
      if (code === null) store.removeItem(DISTRICT_STORAGE_ITEM);
      else store.setItem(DISTRICT_STORAGE_ITEM, code);
      saved = true;
    }
  } catch {
    saved = false;
  }
  // Notify even when storage refused: the in-memory fallback below still changes.
  memory = code;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT));
  return saved;
}

/**
 * When storage is unavailable the choice still holds for this page view, so picking a district
 * never looks broken; it is just not remembered after a reload.
 */
let memory: DistrictCode | null = null;

function snapshot(): DistrictCode | null {
  return readDistrictPreference() ?? memory;
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === DISTRICT_STORAGE_ITEM) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

/**
 * `[district, setDistrict, ready]`. `ready` is `false` during server rendering and hydration (the
 * server cannot know the choice), so callers can avoid flashing the "pick a district" prompt for a
 * customer who already picked one.
 */
export function useDistrictPreference(): [
  DistrictCode | null,
  (code: DistrictCode | null) => void,
  boolean,
] {
  const district = useSyncExternalStore(subscribe, snapshot, () => null);
  const ready = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const set = useCallback((code: DistrictCode | null) => {
    writeDistrictPreference(code);
  }, []);
  return [district, set, ready];
}

const noopSubscribe = () => () => undefined;

/** Test hook: forget the in-memory fallback between tests. */
export function resetDistrictPreferenceMemory(): void {
  memory = null;
}
