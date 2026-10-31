import { useState } from 'react';
import {
  clearPendingAttempt,
  hashBody,
  readPendingAttempt,
  savePendingAttempt,
  type PendingAttempt,
} from './pending-attempt';

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
 * `fingerprint` is the serialized request body; equal fingerprints share a key. The key is also
 * kept in `sessionStorage` (`pending-attempt.ts`), so a retry after a reload or a navigation still
 * finds it.
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

/** Who is placing the order and what it costs: stored with the key, never the body itself. */
export interface AttemptContext {
  owner: string;
  totalUzs: number;
}

/** Where pending attempts outlive the page. `sessionStorage` in the app; a stub in tests. */
export interface AttemptStore {
  read: (now: number) => PendingAttempt | null;
  save: (attempt: PendingAttempt) => void;
  clear: () => void;
}

export const sessionAttemptStore: AttemptStore = {
  read: readPendingAttempt,
  save: savePendingAttempt,
  clear: clearPendingAttempt,
};

/** An in-memory store: nothing survives the controller. */
export const NO_ATTEMPT_STORE: AttemptStore = {
  read: () => null,
  save: () => undefined,
  clear: () => undefined,
};

export interface SubmissionControllerOptions {
  generate?: () => string;
  store?: AttemptStore;
  now?: () => number;
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
  /**
   * The key for a request with this fingerprint: unchanged while the fingerprint (and the owner)
   * is unchanged, including across reloads within the stored attempt's lifetime.
   */
  keyFor: (fingerprint: string, context: AttemptContext) => string;
  /**
   * Forgets the current key, here and in storage (after `idempotency_key_conflict`, or once an
   * order exists).
   */
  reset: () => void;
  readonly locked: boolean;
}

export function createSubmissionController({
  generate = generateIdempotencyKey,
  store = sessionAttemptStore,
  now = Date.now,
}: SubmissionControllerOptions = {}): SubmissionController {
  let locked = false;
  let current: { owner: string; bodyHash: string; key: string } | null = null;

  return {
    tryLock() {
      if (locked) return false;
      locked = true;
      return true;
    },
    unlock() {
      locked = false;
    },
    keyFor(fingerprint, { owner, totalUzs }) {
      const bodyHash = hashBody(fingerprint);
      if (current?.owner === owner && current.bodyHash === bodyHash) return current.key;
      // Not this page's attempt: maybe one from before a reload.
      const stored = store.read(now());
      if (stored?.owner === owner && stored.bodyHash === bodyHash) {
        current = { owner, bodyHash, key: stored.key };
        return stored.key;
      }
      current = { owner, bodyHash, key: generate() };
      store.save({ key: current.key, bodyHash, owner, totalUzs, createdAt: now() });
      return current.key;
    },
    reset() {
      current = null;
      store.clear();
    },
    get locked() {
      return locked;
    },
  };
}

/** One controller per mounted checkout form; its key is also kept in this tab's storage. */
export function useSubmissionController(): SubmissionController {
  const [controller] = useState(() => createSubmissionController());
  return controller;
}
