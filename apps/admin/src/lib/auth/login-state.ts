/**
 * One-time `state` that binds a Telegram Login Widget redirect to a login the user started in
 * this tab (login-CSRF defence).
 *
 * Without it, anyone could send a victim a link to `/<locale>/auth/telegram?id=...&hash=...`
 * carrying the attacker's own, validly signed widget payload, and the callback page would sign the
 * victim in as the attacker. The widget keeps an existing query string on `data-auth-url` and
 * appends its fields with `&`, so the state travels through the redirect; the expected value
 * lives in `sessionStorage`, which a link opened elsewhere (another tab, another site) cannot set.
 */

const STORAGE_KEY = 'mm.telegramLoginState';
/** Matches the server's default login-widget max age. */
export const LOGIN_STATE_MAX_AGE_MS = 10 * 60 * 1000;
const STATE_PATTERN = /^[0-9a-f]{32}$/;

interface StoredState {
  state: string;
  createdAt: number;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null; // storage disabled (privacy mode, sandboxed frame)
  }
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Creates and remembers a fresh state; returns `null` when it cannot be stored (login disabled). */
export function beginLoginState(now: number = Date.now()): string | null {
  const store = storage();
  if (store === null) return null;
  const value: StoredState = { state: randomState(), createdAt: now };
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    return null;
  }
  return value.state;
}

/**
 * True only if `received` equals the state stored by {@link beginLoginState} in this tab and it is
 * not older than {@link LOGIN_STATE_MAX_AGE_MS}. The stored state is consumed either way.
 */
export function consumeLoginState(received: string | null, now: number = Date.now()): boolean {
  const store = storage();
  if (store === null) return false;
  let raw: string | null;
  try {
    raw = store.getItem(STORAGE_KEY);
    store.removeItem(STORAGE_KEY);
  } catch {
    return false;
  }
  if (raw === null || received === null || !STATE_PATTERN.test(received)) return false;

  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof stored !== 'object' || stored === null) return false;
  const { state, createdAt } = stored as Partial<StoredState>;
  if (typeof state !== 'string' || typeof createdAt !== 'number') return false;
  const age = now - createdAt;
  return state === received && age >= 0 && age <= LOGIN_STATE_MAX_AGE_MS;
}
