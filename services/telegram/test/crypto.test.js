import { describe, expect, it } from 'vitest';
import {
  hmacSha256,
  hmacSha256Hex,
  sha256,
  sha256Hex,
  utf8Encode,
} from '../tgcloud/lib/crypto/index.js';
import {
  ADR_VECTOR,
  createRng,
  nodeHmacHex,
  nodeSha256Hex,
  randomBytes,
  randomText,
} from './helpers.js';

const hex = (bytes) => Buffer.from(bytes).toString('hex');

describe('utf8Encode', () => {
  it('matches TextEncoder for empty, ASCII and multibyte input', () => {
    const samples = ['', 'a', 'hello', 'Привет, мир', 'o‘zbek tili', '€', '😀', 'a😀b', '日本語'];
    for (const s of samples) {
      expect(Array.from(utf8Encode(s))).toEqual(Array.from(new TextEncoder().encode(s)));
    }
  });

  it('matches TextEncoder on random strings including lone surrogates', () => {
    const rng = createRng(1);
    for (let i = 0; i < 300; i += 1) {
      const s = randomText(rng, Math.floor(rng() * 80), { loneSurrogates: true });
      expect(Array.from(utf8Encode(s))).toEqual(Array.from(new TextEncoder().encode(s)));
    }
  });
});

describe('sha256', () => {
  it('matches known vectors', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(utf8Encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches node:crypto for every length across padding boundaries', () => {
    const rng = createRng(2);
    for (let length = 0; length <= 260; length += 1) {
      const data = randomBytes(rng, length);
      expect(hex(sha256(data))).toBe(nodeSha256Hex(data));
    }
  });

  it('matches node:crypto on random multibyte UTF-8 text and larger inputs', () => {
    const rng = createRng(3);
    for (let i = 0; i < 100; i += 1) {
      const bytes = utf8Encode(randomText(rng, Math.floor(rng() * 300), { loneSurrogates: true }));
      expect(sha256Hex(bytes)).toBe(nodeSha256Hex(bytes));
    }
    for (const length of [1000, 4096, 65537]) {
      const data = randomBytes(rng, length);
      expect(sha256Hex(data)).toBe(nodeSha256Hex(data));
    }
  });
});

describe('hmacSha256', () => {
  it('matches RFC 4231 test case 1 and 2', () => {
    const key1 = new Uint8Array(20).fill(0x0b);
    expect(hmacSha256Hex(key1, utf8Encode('Hi There'))).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
    expect(hmacSha256Hex(utf8Encode('Jefe'), utf8Encode('what do ya want for nothing?'))).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('matches node:crypto for random keys (empty, short, 64, >64 bytes) and messages', () => {
    const rng = createRng(4);
    const keyLengths = [0, 1, 31, 32, 63, 64, 65, 100, 128, 200];
    for (const keyLength of keyLengths) {
      for (let i = 0; i < 10; i += 1) {
        const key = randomBytes(rng, keyLength);
        const message = utf8Encode(
          randomText(rng, Math.floor(rng() * 120), { loneSurrogates: true }),
        );
        expect(hex(hmacSha256(key, message))).toBe(nodeHmacHex(key, message));
      }
    }
  });

  it('matches node:crypto for multibyte string keys', () => {
    const rng = createRng(5);
    for (let i = 0; i < 50; i += 1) {
      const key = utf8Encode(randomText(rng, 1 + Math.floor(rng() * 60)));
      const message = utf8Encode(randomText(rng, Math.floor(rng() * 60)));
      expect(hmacSha256Hex(key, message)).toBe(nodeHmacHex(key, message));
    }
  });

  it('reproduces the ADR 0003 signature vector at the primitive level', () => {
    const body = utf8Encode(ADR_VECTOR.body);
    expect(sha256Hex(body)).toBe(ADR_VECTOR.bodySha256);
    const canonical = [
      'MM-SVC-V1',
      ADR_VECTOR.keyId,
      String(ADR_VECTOR.timestamp),
      ADR_VECTOR.nonce,
      ADR_VECTOR.method,
      ADR_VECTOR.path,
      ADR_VECTOR.actor,
      ADR_VECTOR.bodySha256,
    ].join('\n');
    expect(hmacSha256Hex(utf8Encode(ADR_VECTOR.secret), utf8Encode(canonical))).toBe(
      ADR_VECTOR.signature,
    );
  });
});
