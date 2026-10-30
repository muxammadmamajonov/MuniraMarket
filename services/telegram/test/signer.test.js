import { describe, expect, it } from 'vitest';
import { canonicalString, signRequest } from '../tgcloud/lib/coreApi/signer.js';
import { generateNonce } from '../tgcloud/lib/coreApi/nonce.js';
import { ADR_VECTOR, createRng } from './helpers.js';

const base = () => ({
  keyId: ADR_VECTOR.keyId,
  secret: ADR_VECTOR.secret,
  method: ADR_VECTOR.method,
  pathWithQuery: ADR_VECTOR.path,
  actor: ADR_VECTOR.actor,
  body: ADR_VECTOR.body,
  timestamp: ADR_VECTOR.timestamp,
  nonce: ADR_VECTOR.nonce,
});

describe('signRequest (ADR 0003 vector)', () => {
  it('builds the exact 8-line canonical string', () => {
    expect(
      canonicalString({
        keyId: ADR_VECTOR.keyId,
        timestamp: ADR_VECTOR.timestamp,
        nonce: ADR_VECTOR.nonce,
        method: ADR_VECTOR.method,
        pathWithQuery: ADR_VECTOR.path,
        actor: ADR_VECTOR.actor,
        bodySha256Hex: ADR_VECTOR.bodySha256,
      }),
    ).toBe(
      [
        'MM-SVC-V1',
        'test-key',
        '1767225600',
        'n0nce-abc123-0001',
        'POST',
        '/api/v1/internal/telegram/session',
        'tg:123456789',
        ADR_VECTOR.bodySha256,
      ].join('\n'),
    );
  });

  it('reproduces the signature and emits all five headers', () => {
    expect(signRequest(base())).toEqual({
      'X-MM-Key-Id': 'test-key',
      'X-MM-Timestamp': '1767225600',
      'X-MM-Nonce': 'n0nce-abc123-0001',
      'X-MM-Actor': 'tg:123456789',
      'X-MM-Signature': ADR_VECTOR.signature,
    });
  });

  it('signs identical bytes whether the body is a string or a Uint8Array', () => {
    const bytes = new TextEncoder().encode(ADR_VECTOR.body);
    expect(signRequest({ ...base(), body: bytes })['X-MM-Signature']).toBe(ADR_VECTOR.signature);
  });

  it('uses the SHA-256 of the empty string for requests without a body', () => {
    const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const noBody = signRequest({ ...base(), body: undefined });
    const emptyBody = signRequest({ ...base(), body: '' });
    expect(noBody['X-MM-Signature']).toBe(emptyBody['X-MM-Signature']);
    expect(noBody['X-MM-Signature']).not.toBe(ADR_VECTOR.signature);
    expect(
      canonicalString({
        keyId: 'k',
        timestamp: 1,
        nonce: 'a'.repeat(16),
        method: 'get',
        pathWithQuery: '/x?a=1',
        actor: '',
        bodySha256Hex: empty,
      }).split('\n'),
    ).toEqual(['MM-SVC-V1', 'k', '1', 'a'.repeat(16), 'GET', '/x?a=1', '', empty]);
  });

  it('sends an empty actor header when no user is acting', () => {
    expect(signRequest({ ...base(), actor: '' })['X-MM-Actor']).toBe('');
    expect(signRequest({ ...base(), actor: null })['X-MM-Actor']).toBe('');
  });

  it('binds method, path/query, actor, body and timestamp into the signature', () => {
    const sig = (patch) => signRequest({ ...base(), ...patch })['X-MM-Signature'];
    const variants = [
      sig({ method: 'PUT' }),
      sig({ pathWithQuery: '/api/v1/internal/telegram/session?a=1' }),
      sig({ actor: 'tg:123456780' }),
      sig({ body: '{"telegram_user_id":1}' }),
      sig({ timestamp: ADR_VECTOR.timestamp + 1 }),
      sig({ nonce: 'n0nce-abc123-0002' }),
      sig({ keyId: 'other-key' }),
    ];
    expect(new Set([ADR_VECTOR.signature, ...variants]).size).toBe(variants.length + 1);
  });

  it('rejects malformed inputs and short secrets', () => {
    expect(() => signRequest({ ...base(), secret: 'short' })).toThrow(/at least 32 bytes/);
    expect(() => signRequest({ ...base(), keyId: 'bad key' })).toThrow(TypeError);
    expect(() => signRequest({ ...base(), keyId: 'k'.repeat(33) })).toThrow(TypeError);
    expect(() => signRequest({ ...base(), nonce: 'short' })).toThrow(TypeError);
    expect(() => signRequest({ ...base(), nonce: 'has space has space' })).toThrow(TypeError);
    expect(() => signRequest({ ...base(), timestamp: 'abc' })).toThrow(TypeError);
    expect(() => signRequest({ ...base(), actor: 'tg:abc' })).toThrow(TypeError);
    expect(() => signRequest({ ...base(), actor: 'tg:0' })).toThrow(TypeError);
    expect(() => signRequest({ ...base(), pathWithQuery: 'no-slash' })).toThrow(TypeError);
    expect(() => signRequest({ ...base(), pathWithQuery: '/a\nb' })).toThrow(TypeError);
    expect(() => signRequest({ ...base(), pathWithQuery: '/a#frag' })).toThrow(TypeError);
  });

  it('counts the secret length in UTF-8 bytes', () => {
    // 11 two-byte characters = 22 bytes (too short), 16 = 32 bytes (ok)
    expect(() => signRequest({ ...base(), secret: 'ё'.repeat(11) })).toThrow();
    expect(() => signRequest({ ...base(), secret: 'ё'.repeat(16) })).not.toThrow();
  });
});

describe('generateNonce', () => {
  const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

  it('uses getRandomValues when available', () => {
    const nonce = generateNonce({
      getRandomValues: (array) => {
        array.fill(65);
        return array;
      },
    });
    expect(nonce).toMatch(NONCE_RE);
    expect(nonce).toHaveLength(24);
  });

  it('falls back to timestamp + counter + Math.random and stays unique and well-formed', () => {
    const rng = createRng(9);
    const seen = new Set();
    for (let i = 0; i < 2000; i += 1) {
      // Fixed clock and low-quality random: the counter alone must still keep nonces distinct.
      const nonce = generateNonce({
        getRandomValues: null,
        random: () => 0.5 + rng() * 0,
        now: () => 1767225600000,
      });
      expect(nonce).toMatch(NONCE_RE);
      seen.add(nonce);
    }
    expect(seen.size).toBe(2000);
  });

  it('works with the real platform sources', () => {
    expect(generateNonce()).toMatch(NONCE_RE);
    expect(generateNonce()).not.toBe(generateNonce());
  });
});
