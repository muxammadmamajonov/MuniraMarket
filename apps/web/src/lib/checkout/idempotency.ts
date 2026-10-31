import { useState } from 'react';

/**
 * Idempotency and double-submit protection for `POST /orders`.
 *
 * The API treats the same `Idempotency-Key` with the same body as the same order: a retry returns
 * the order that was already created (200 + `Idempotent-Replayed: true`) instead of a second one.
 * The same key with a different body is refused (`idempotency_key_conflict`). So:
 *
 * - retrying an identical request (network error, 5xx, 429, a second tap after a timeout) must
 *   reuse the key, otherwise a request that actually reached the server is placed twice;
 * - any change to the body (a different address, or a new `expected_total_uzs` after the customer
 *   confirmed a price change) must use a new key.
 *
 * `fingerprint` is the serialized request body; equal fingerprints share a key.
 */

const KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** A fresh key: `crypto.randomUUID()`, with a `getRandomValues` fallback for insecure contexts. */
export function generateIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  // `randomUUID` exists only in secure contexts (HTTPS / localhost); a phone opening a dev server
  // over a LAN IP has `getRandomValues` but not `randomUUID`.
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** True for keys the API accepts. */
export function isValidIdempotencyKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export interface SubmissionController {
  /**
   * Takes the submission lock. Returns `false` when an attempt is already in flight. Synchronous
   * on purpose: two taps in the same tick both see the lock, which React state alone cannot
   * guarantee (state updates are applied after the handler returns).
   */
  tryLock: () => boolean;
  /** Releases the lock after a failed attempt so the customer can retry. */
  unlock: () => void;
  /** The key for a request with this fingerprint: unchanged while the fingerprint is unchanged. */
  keyFor: (fingerprint: string) => string;
  /** Forgets the current key (after `idempotency_key_conflict`, or once an order exists). */
  reset: () => void;
  readonly locked: boolean;
}

export function createSubmissionController(
  generate: () => string = generateIdempotencyKey,
): SubmissionController {
  let locked = false;
  let current: { fingerprint: string; key: string } | null = null;

  return {
    tryLock() {
      if (locked) return false;
      locked = true;
      return true;
    },
    unlock() {
      locked = false;
    },
    keyFor(fingerprint) {
      if (current?.fingerprint !== fingerprint) current = { fingerprint, key: generate() };
      return current.key;
    },
    reset() {
      current = null;
    },
    get locked() {
      return locked;
    },
  };
}

/** One controller per mounted checkout form; it lives as long as the form does. */
export function useSubmissionController(): SubmissionController {
  const [controller] = useState(() => createSubmissionController());
  return controller;
}
