import { describe, expect, it } from 'vitest';
import { isSafeRequestPath } from '../tgcloud/lib/coreApi/path.js';
import { signRequest } from '../tgcloud/lib/coreApi/signer.js';
import { createCoreApiClient } from '../tgcloud/lib/coreApi/client.js';
import { createFakeFetch } from './sdk-fake/fetch.js';
import { ADR_VECTOR } from './helpers.js';

const ACCEPTED = [
  '/',
  '/api/v1/internal/telegram/me',
  '/a/b-c_d.e~f',
  "/a!$&'()*+,;=:@b",
  '/a?x=1&y=2',
  '/a?q=a/b?c',
  '/a%20b?x=%41',
  '/a/.hidden',
  '/a/...',
  '/a/b.',
];

const REJECTED = [
  '',
  'a',
  '//host/x',
  '/a b',
  '/a\\b',
  '/a"b',
  '/a<b',
  '/a>b',
  '/a`b',
  '/a{b',
  '/a}b',
  '/a|b',
  '/a^b',
  '/a?x=a b',
  '/a?x="',
  '/a?x=<',
  '/a#f',
  '/a?x=1#f',
  '/a\nb',
  '/a\tb',
  '/é',
  '/a%2',
  '/a%zz',
  '/a%',
  '/a?x=%',
  '/./a',
  '/a/./b',
  '/a/..',
  '/a/../b',
  '/a/%2e/b',
  '/a/%2E/b',
  '/a/%2e%2e/b',
  '/a/.%2E/b',
  '/a/%2E./b',
  '/%2e%2e',
];

describe('isSafeRequestPath', () => {
  it.each(ACCEPTED)('accepts %j', (p) => expect(isSafeRequestPath(p)).toBe(true));
  it.each(REJECTED)('rejects %j', (p) => expect(isSafeRequestPath(p)).toBe(false));
  it('rejects non-strings', () => {
    for (const v of [undefined, null, 1, {}]) expect(isSafeRequestPath(v)).toBe(false);
  });
  it('allows dots inside the query (only path segments are checked)', () => {
    expect(isSafeRequestPath('/a?x=../b')).toBe(true);
  });
});

describe('shared path rules in signer and client', () => {
  const sign = (pathWithQuery) =>
    signRequest({
      keyId: ADR_VECTOR.keyId,
      secret: ADR_VECTOR.secret,
      method: 'GET',
      pathWithQuery,
      timestamp: ADR_VECTOR.timestamp,
      nonce: ADR_VECTOR.nonce,
    });

  it('both refuse every rejected path and accept every accepted one', async () => {
    const fetch = createFakeFetch();
    const client = createCoreApiClient({
      fetch,
      config: {
        baseUrl: 'https://core.example.test',
        keyId: ADR_VECTOR.keyId,
        secret: ADR_VECTOR.secret,
      },
    });
    for (const p of REJECTED) {
      expect(() => sign(p), p).toThrow(TypeError);
      await expect(client.request('GET', p), p).rejects.toThrow(TypeError);
    }
    for (const p of ACCEPTED) {
      expect(() => sign(p), p).not.toThrow();
      await client.request('GET', p);
    }
    expect(fetch.calls).toHaveLength(ACCEPTED.length);
    expect(fetch.calls.map((c) => c.url)).toEqual(
      ACCEPTED.map((p) => `https://core.example.test${p}`),
    );
  });
});
