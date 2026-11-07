// @ts-check
/**
 * Nonce generation for the `X-MM-Nonce` header (`[A-Za-z0-9_-]{16,64}`).
 *
 * A nonce only has to be UNIQUE per request (the Core API uses it for replay protection); it is
 * not a secret and is not used for key material. The supported Serverless runtime provides
 * `crypto.getRandomValues`, so:
 *
 * 1. If `globalThis.crypto.getRandomValues` exists, use it (24 chars, 144 random bits).
 * 2. Otherwise fail closed. A weak nonce could undermine replay protection across isolates.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const NONCE_BYTES = 24;

/**
 * @typedef {object} NonceSources
 * @property {((array: Uint8Array) => Uint8Array) | null} [getRandomValues]
 */

/**
 * @returns {((array: Uint8Array) => Uint8Array) | null}
 */
function platformGetRandomValues() {
  // Read through an untyped view of globalThis: `crypto` is typed differently (or not at all) by
  // the Node and Workers type libraries that check this shared module.
  const scope = /** @type {{ crypto?: unknown }} */ (/** @type {unknown} */ (globalThis));
  const c = /** @type {{ getRandomValues?: (array: Uint8Array) => Uint8Array } | undefined} */ (
    scope.crypto
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

  if (!getRandomValues) throw new TypeError('Secure randomness is unavailable');
  const bytes = new Uint8Array(NONCE_BYTES);
  getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += ALPHABET[(bytes[i] ?? 0) & 63] ?? 'A';
  }
  return out;
}
