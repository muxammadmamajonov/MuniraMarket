// @ts-check
/**
 * HMAC-SHA256 (RFC 2104) on top of the pure-JS SHA-256, plus hex helpers.
 */
import { sha256 } from './sha256.js';

const BLOCK_SIZE = 64;
const HEX = '0123456789abcdef';

/**
 * @param {Uint8Array} bytes
 * @returns {string} lowercase hex
 */
export function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i] ?? 0;
    out += (HEX[b >>> 4] ?? '') + (HEX[b & 0x0f] ?? '');
  }
  return out;
}

/**
 * @param {Uint8Array} data
 * @returns {string} lowercase hex SHA-256
 */
export function sha256Hex(data) {
  return bytesToHex(sha256(data));
}

/**
 * @param {Uint8Array} key any length; keys longer than the block size are hashed first
 * @param {Uint8Array} message
 * @returns {Uint8Array} 32-byte MAC
 */
export function hmacSha256(key, message) {
  const normalizedKey = key.length > BLOCK_SIZE ? sha256(key) : key;
  const inner = new Uint8Array(BLOCK_SIZE + message.length);
  const outer = new Uint8Array(BLOCK_SIZE + 32);
  for (let i = 0; i < BLOCK_SIZE; i += 1) {
    const k = normalizedKey[i] ?? 0;
    inner[i] = k ^ 0x36;
    outer[i] = k ^ 0x5c;
  }
  inner.set(message, BLOCK_SIZE);
  outer.set(sha256(inner), BLOCK_SIZE);
  return sha256(outer);
}

/**
 * @param {Uint8Array} key
 * @param {Uint8Array} message
 * @returns {string} lowercase hex MAC
 */
export function hmacSha256Hex(key, message) {
  return bytesToHex(hmacSha256(key, message));
}
