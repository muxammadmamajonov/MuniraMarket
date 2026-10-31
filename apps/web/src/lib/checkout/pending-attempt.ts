import type { OrderSummary } from '@muniramarket/contracts';

/**
 * The order attempt that has not been confirmed yet, kept in `sessionStorage` so that it outlives
 * a reload or a navigation in this tab.
 *
 * Without it, an order that timed out (or lost its connection) and was then retried after a
 * reload went out under a fresh `Idempotency-Key`. If the first request had reached the server,
 * that could place the order twice. With it, a retry of the same body reuses the stored key and
 * the API returns the existing order (`Idempotent-Replayed: true`) instead.
 *
 * What is stored: the key, a hash of the serialized request body (never the body itself: it holds
 * the recipient's name, phone and address), the owner's user id, the total that was sent, and
 * when the attempt started. It is dropped once an order exists, when the body changes (a new key
 * replaces it), after `idempotency_key_conflict`, and after {@link PENDING_ATTEMPT_MAX_AGE_MS}.
 *
 * Every storage access is guarded: privacy modes, sandboxed frames and some Telegram WebViews
 * refuse or throw, and checkout must keep working (with in-memory keys only) when they do.
 */

const STORAGE_KEY = 'mm.checkoutAttempt';
/** A pending attempt is reused for a day; after that a retry is a new attempt. */
export const PENDING_ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * How far the server's `created_at` may be before the attempt's (client-clock) start and still be
 * that attempt's order. Phone clocks drift by minutes.
 */
export const CLOCK_SKEW_MS = 10 * 60 * 1000;

const KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const HASH_PATTERN = /^[0-9a-f]{16}$/;

export interface PendingAttempt {
  key: string;
  /** {@link hashBody} of the serialized request body. */
  bodyHash: string;
  /** The signed-in user's id: another account in the same tab never reuses the attempt. */
  owner: string;
  /** `expected_total_uzs` of the request, to recognise the order it created. */
  totalUzs: number;
  /** `Date.now()` when the attempt was first sent. */
  createdAt: number;
}

/**
 * A 64-bit hash of `text` (cyrb64: two mixed 32-bit lanes) as 16 hex characters. Not a security
 * measure (anything that can read this tab's storage can read the form): it only keeps personal
 * data out of storage and makes equal bodies compare equal. Synchronous, so the key is known in
 * the same tick as the tap (`crypto.subtle` is async and missing in insecure contexts).
 */
export function hashBody(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, '0');
  return hex(h2) + hex(h1);
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null; // storage disabled (privacy mode, sandboxed frame)
  }
}

function isPendingAttempt(value: unknown): value is PendingAttempt {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PendingAttempt>;
  return (
    typeof candidate.key === 'string' &&
    KEY_PATTERN.test(candidate.key) &&
    typeof candidate.bodyHash === 'string' &&
    HASH_PATTERN.test(candidate.bodyHash) &&
    typeof candidate.owner === 'string' &&
    candidate.owner !== '' &&
    typeof candidate.totalUzs === 'number' &&
    Number.isSafeInteger(candidate.totalUzs) &&
    typeof candidate.createdAt === 'number' &&
    Number.isFinite(candidate.createdAt)
  );
}

/**
 * The stored attempt, or `null` when there is none, it is malformed, or it is older than
 * {@link PENDING_ATTEMPT_MAX_AGE_MS} (or from the future: a clock that jumped back). Anything
 * unusable is removed.
 */
export function readPendingAttempt(now: number = Date.now()): PendingAttempt | null {
  const store = storage();
  if (store === null) return null;
  let raw: string | null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!isPendingAttempt(parsed)) {
    clearPendingAttempt();
    return null;
  }
  const age = now - parsed.createdAt;
  if (age < 0 || age > PENDING_ATTEMPT_MAX_AGE_MS) {
    clearPendingAttempt();
    return null;
  }
  return parsed;
}

/** Remembers `attempt`, replacing any earlier one. Silently does nothing without storage. */
export function savePendingAttempt(attempt: PendingAttempt): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(attempt));
  } catch {
    // Quota or a refusing WebView: the in-memory key still covers retries on this page.
  }
}

export function clearPendingAttempt(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do: an unreadable entry is ignored by `readPendingAttempt` anyway.
  }
}

/**
 * The order a pending attempt most likely created, from the customer's newest orders: same total,
 * created no earlier than the attempt started (less {@link CLOCK_SKEW_MS}). Only meaningful when
 * the cart came back empty, because placing an order empties the cart on the server.
 */
export function findOrderForAttempt(
  attempt: PendingAttempt,
  orders: readonly OrderSummary[],
): OrderSummary | null {
  const earliest = attempt.createdAt - CLOCK_SKEW_MS;
  return (
    orders.find(
      (order) => order.total_uzs === attempt.totalUzs && Date.parse(order.created_at) >= earliest,
    ) ?? null
  );
}
