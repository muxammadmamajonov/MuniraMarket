'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { parseAddress, type Address } from './address';

/**
 * The customer's current delivery address, remembered on this device only (localStorage) so that
 * the home card and checkout show the same address and the customer does not re-enter it. It never
 * leaves the device except inside an order. A later "My addresses" page can keep several addresses
 * server-side; this module is the single place to swap that in.
 *
 * Storage can be missing or throw (private mode, blocked site data, a Telegram WebView with
 * storage disabled), so every access is guarded and an in-memory copy keeps the choice for this
 * page view. A stored value that does not parse is ignored, never trusted.
 */

export const ADDRESS_STORAGE_ITEM = 'mm.delivery-address.v1';

/** Same-tab change notification; `storage` events only reach other tabs. */
const CHANGE_EVENT = 'mm:delivery-address';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readRaw(): string | null {
  try {
    return storage()?.getItem(ADDRESS_STORAGE_ITEM) ?? null;
  } catch {
    return null;
  }
}

/** `useSyncExternalStore` needs a stable snapshot: re-parse only when the raw string changes. */
let cache: { raw: string | null; value: Address | null } = { raw: null, value: null };

function parseRaw(raw: string | null): Address | null {
  if (raw === cache.raw) return cache.value;
  let value: Address | null = null;
  if (raw !== null) {
    try {
      value = parseAddress(JSON.parse(raw));
    } catch {
      value = null;
    }
  }
  cache = { raw, value };
  return value;
}

let memory: Address | null = null;

export function readDeliveryAddress(): Address | null {
  return parseRaw(readRaw()) ?? memory;
}

/** Saves `address` (or forgets it with `null`). Returns whether storage accepted it. */
export function writeDeliveryAddress(address: Address | null): boolean {
  let saved = false;
  try {
    const store = storage();
    if (store !== null) {
      if (address === null) store.removeItem(ADDRESS_STORAGE_ITEM);
      else store.setItem(ADDRESS_STORAGE_ITEM, JSON.stringify(address));
      saved = true;
    }
  } catch {
    saved = false;
  }
  memory = address;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT));
  return saved;
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === ADDRESS_STORAGE_ITEM) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

const noopSubscribe = () => () => undefined;

/**
 * `[address, setAddress, ready]`. `ready` is `false` during server rendering and hydration (the
 * server cannot know the address), so callers can avoid flashing the "choose an address" prompt.
 */
export function useDeliveryAddress(): [Address | null, (address: Address | null) => void, boolean] {
  const address = useSyncExternalStore(subscribe, readDeliveryAddress, () => null);
  const ready = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const set = useCallback((next: Address | null) => {
    writeDeliveryAddress(next);
  }, []);
  return [address, set, ready];
}

/** Test hook: forget the in-memory fallback and the parse cache between tests. */
export function resetDeliveryAddressMemory(): void {
  memory = null;
  cache = { raw: null, value: null };
}
