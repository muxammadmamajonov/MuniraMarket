import { createHash, createHmac } from 'node:crypto';

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
export function createRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomBytes(rng, length) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = Math.floor(rng() * 256);
  return out;
}

/** Random string mixing ASCII, Latin, Cyrillic, CJK, astral (emoji) and lone surrogates. */
export function randomText(rng, length, { loneSurrogates = false } = {}) {
  const pools = [
    () => String.fromCharCode(0x20 + Math.floor(rng() * 0x5f)),
    () => String.fromCharCode(0xc0 + Math.floor(rng() * 0x100)),
    () => String.fromCharCode(0x410 + Math.floor(rng() * 0x40)),
    () => String.fromCharCode(0x4e00 + Math.floor(rng() * 0x500)),
    () => String.fromCodePoint(0x1f300 + Math.floor(rng() * 0x300)),
  ];
  if (loneSurrogates) pools.push(() => String.fromCharCode(0xd800 + Math.floor(rng() * 0x800)));
  let out = '';
  for (let i = 0; i < length; i += 1) out += pools[Math.floor(rng() * pools.length)]();
  return out;
}

export const nodeSha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const nodeHmacHex = (key, bytes) => createHmac('sha256', key).update(bytes).digest('hex');

/** The ADR 0003 test vector. */
export const ADR_VECTOR = Object.freeze({
  secret: 'test-only-secret-not-for-production-0001',
  keyId: 'test-key',
  timestamp: 1767225600,
  nonce: 'n0nce-abc123-0001',
  method: 'POST',
  path: '/api/v1/internal/telegram/session',
  actor: 'tg:123456789',
  body: '{"telegram_user_id":123456789}',
  bodySha256: 'c4c0f3c754b25d079cc6a56808b61d6967e6eb03feb9f39cb9ff6f5d9c8a12ec',
  signature: '4f759f2ee938c855bca8f77302d9ccd54ae37cbd52d0942eb9b4dee95c8a43fc',
});

/** Test-only service config. Not a real secret. */
export const TEST_CONFIG_ROWS = Object.freeze({
  core_api_base_url: 'https://core.example.test',
  service_key_id: 'test-key',
  service_secret: ADR_VECTOR.secret,
});

export function rowsFrom(record) {
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

export function silentLogger() {
  const entries = [];
  const push =
    (level) =>
    (...args) =>
      entries.push({ level, text: args.map(String).join(' ') });
  return { log: push('log'), warn: push('warn'), error: push('error'), entries };
}
