// @ts-check
/**
 * Request signer for service-to-service calls to the Core API.
 * Implements the SIGNER side of architecture/0003-service-auth-contract.md exactly.
 */
import { bytesToHex, hmacSha256, sha256Hex, utf8Encode } from '../crypto/index.js';
import { isSafeRequestPath } from './path.js';

export const SIGNATURE_VERSION = 'MM-SVC-V1';
export const MIN_SECRET_BYTES = 32;

const KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TIMESTAMP_RE = /^[0-9]{1,15}$/;
const ACTOR_RE = /^tg:[1-9][0-9]{0,15}$/;
const METHOD_RE = /^[A-Za-z]{1,16}$/;

/**
 * @param {string | Uint8Array | undefined | null} body
 * @returns {Uint8Array}
 */
function bodyBytes(body) {
  if (body === undefined || body === null) return new Uint8Array(0);
  return typeof body === 'string' ? utf8Encode(body) : body;
}

/**
 * Validates and normalises the shared inputs of the canonical string.
 * @param {{ keyId: string, timestamp: number | string, nonce: string, method: string, pathWithQuery: string, actor?: string | null }} input
 */
function checkFields(input) {
  if (!KEY_ID_RE.test(input.keyId)) throw new TypeError('Invalid key id');
  const timestamp = String(input.timestamp);
  if (!TIMESTAMP_RE.test(timestamp)) throw new TypeError('Invalid timestamp');
  if (!NONCE_RE.test(input.nonce)) throw new TypeError('Invalid nonce');
  if (!METHOD_RE.test(input.method)) throw new TypeError('Invalid method');
  if (!isSafeRequestPath(input.pathWithQuery)) {
    throw new TypeError('Invalid path');
  }
  const actor = input.actor ?? '';
  if (actor !== '' && !ACTOR_RE.test(actor)) throw new TypeError('Invalid actor');
  return { timestamp, method: input.method.toUpperCase(), actor };
}

/**
 * Builds the 8-line canonical string (joined by LF, no trailing newline).
 *
 * @param {{ keyId: string, timestamp: number | string, nonce: string, method: string, pathWithQuery: string, actor?: string | null, bodySha256Hex: string }} input
 * @returns {string}
 */
export function canonicalString(input) {
  const { timestamp, method, actor } = checkFields(input);
  if (!/^[0-9a-f]{64}$/.test(input.bodySha256Hex)) throw new TypeError('Invalid body digest');
  return [
    SIGNATURE_VERSION,
    input.keyId,
    timestamp,
    input.nonce,
    method,
    input.pathWithQuery,
    actor,
    input.bodySha256Hex,
  ].join('\n');
}

/**
 * Signs one request and returns the headers to attach.
 *
 * `body` must be exactly the bytes (or the string that will be UTF-8 encoded into the bytes) that
 * are sent on the wire. Omit it for requests without a body.
 *
 * @param {object} params
 * @param {string} params.keyId
 * @param {string} params.secret at least 32 UTF-8 bytes
 * @param {string} params.method
 * @param {string} params.pathWithQuery request path including query string, as sent
 * @param {string | null} [params.actor] `tg:<telegram_user_id>` or empty
 * @param {string | Uint8Array | null} [params.body]
 * @param {number | string} params.timestamp Unix seconds
 * @param {string} params.nonce
 * @returns {Record<string, string>}
 */
export function signRequest({
  keyId,
  secret,
  method,
  pathWithQuery,
  actor = '',
  body,
  timestamp,
  nonce,
}) {
  const secretBytes = utf8Encode(secret);
  if (secretBytes.length < MIN_SECRET_BYTES) {
    throw new TypeError(`Signing secret must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  const bodySha256Hex = sha256Hex(bodyBytes(body));
  const canonical = canonicalString({
    keyId,
    timestamp,
    nonce,
    method,
    pathWithQuery,
    actor,
    bodySha256Hex,
  });
  const signature = bytesToHex(hmacSha256(secretBytes, utf8Encode(canonical)));
  return {
    'X-MM-Key-Id': keyId,
    'X-MM-Timestamp': String(timestamp),
    'X-MM-Nonce': nonce,
    // ADR 0003: present, and empty when no user is acting.
    'X-MM-Actor': actor ?? '',
    'X-MM-Signature': signature,
  };
}
