// @ts-check
/**
 * Nonce generation for the `X-MM-Nonce` header (`[A-Za-z0-9_-]{16,64}`).
 *
 * A nonce only has to be UNIQUE per request (the Core API uses it for replay protection); it is
 * not a secret and is not used for key material. The Serverless runtime does not document
 * `crypto.getRandomValues`, so:
 *
 * 1. If `globalThis.crypto.getRandomValues` exists, use it (24 chars, 144 random bits).
 * 2. Otherwise fall back to timestamp + a monotonic per-isolate counter + `Math.random` output.
 *    Uniqueness then rests on the counter inside one isolate and on the timestamp/`Math.random`
 *    mix across isolates; that is sufficient for replay detection but must never be reused for
 *    anything that needs unpredictability.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const NONCE_BYTES = 24;

let counter = 0;

/**
 * @typedef {object} NonceSources
 * @property {((array: Uint8Array) => Uint8Array) | null} [getRandomValues]
 * @property {() => number} [random] returns a float in [0, 1)
 * @property {() => number} [now] epoch milliseconds
 */

/**
 * @returns {((array: Uint8Array) => Uint8Array) | null}
 */
function platformGetRandomValues() {
  const c = /** @type {{ getRandomValues?: (array: Uint8Array) => Uint8Array } | undefined} */ (
    /** @type {unknown} */ (globalThis.crypto)
  );
  if (c && typeof c.getRandomValues === 'function') {
    return (array) =>
      /** @type {NonNullable<typeof c.getRandomValues>} */ (c.getRandomValues)(array);
  }
  return null;
}

/**
 * @param {NonceSources} [sources] overridable for tests
 * @returns {string}
 */
export function generateNonce(sources = {}) {
  const getRandomValues =
    sources.getRandomValues === undefined ? platformGetRandomValues() : sources.getRandomValues;

  if (getRandomValues) {
    const bytes = new Uint8Array(NONCE_BYTES);
    getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) {
      out += ALPHABET[(bytes[i] ?? 0) & 63] ?? 'A';
    }
    return out;
  }

  const random = sources.random ?? Math.random;
  const now = sources.now ?? Date.now;
  counter = (counter + 1) % 0x7fffffff;
  const time = Math.floor(now()).toString(36);
  const seq = counter.toString(36);
  let noise = '';
  while (noise.length < 14) {
    noise += Math.floor(random() * 36 ** 7)
      .toString(36)
      .padStart(7, '0');
  }
  return `${time}-${seq}-${noise.slice(0, 14)}`.slice(0, 64).padEnd(16, '0');
}
