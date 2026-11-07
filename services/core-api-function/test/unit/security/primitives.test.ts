import { describe, expect, it } from 'vitest';
import { expiredCookieHeader, sessionCookieHeader } from '../../../src/security/cookies.ts';
import { checkOrigin, checkToken, CsrfError } from '../../../src/security/csrf.ts';
import { rateLimitKey, windowFor } from '../../../src/security/rateLimit.ts';
import {
  canonicalString,
  MAX_SKEW_SECONDS,
  precheck,
  ServiceAuthError,
  sign,
} from '../../../src/security/serviceAuth.ts';
import {
  decodeRecord,
  hashToken,
  isWellFormedToken,
  newToken,
  parseSessionData,
} from '../../../src/security/session.ts';
import { retryDelaySeconds } from '../../../src/repositories/outbox.ts';
import { signedHeaders } from './helpers.ts';

const TRUSTED = ['https://shop.example', 'https://admin.example'];

describe('session cookies (exact Set-Cookie strings of app/security/cookies.py)', () => {
  it('formats a host-only HttpOnly Lax cookie', () => {
    expect(
      sessionCookieHeader({ name: '__Host-mm_session', token: 'tok', maxAge: 60, secure: true }),
    ).toBe('__Host-mm_session=tok; Max-Age=60; Path=/; HttpOnly; SameSite=Lax; Secure');
    expect(
      sessionCookieHeader({ name: 'mm_session', token: 'tok', maxAge: 60, secure: false }),
    ).toBe('mm_session=tok; Max-Age=60; Path=/; HttpOnly; SameSite=Lax');
  });

  it('formats the expiring cookie', () => {
    expect(expiredCookieHeader({ name: '__Host-mm_session', secure: true })).toBe(
      '__Host-mm_session=""; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure',
    );
  });
});

describe('CSRF', () => {
  const deployed = { trustedOrigins: TRUSTED, appEnv: 'production' as const };

  it('accepts a trusted Origin, or the origin of Referer', () => {
    expect(() =>
      checkOrigin({ origin: 'https://shop.example', referer: undefined }, deployed),
    ).not.toThrow();
    expect(() =>
      checkOrigin({ origin: undefined, referer: 'https://admin.example/uz/orders?x=1' }, deployed),
    ).not.toThrow();
    expect(() =>
      checkOrigin({ origin: 'HTTPS://SHOP.EXAMPLE:443', referer: undefined }, deployed),
    ).not.toThrow();
  });

  it.each([
    ['https://evil.example', 'origin_untrusted'],
    ['null', 'origin_untrusted'],
    ['https://shop.example.evil.example', 'origin_untrusted'],
    ['http://shop.example', 'origin_untrusted'],
  ])('rejects Origin %s', (origin, reason) => {
    try {
      checkOrigin({ origin, referer: undefined }, deployed);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CsrfError);
      expect((error as CsrfError).reason).toBe(reason);
    }
  });

  it('requires an origin when deployed, not in development/test', () => {
    expect(() => checkOrigin({ origin: undefined, referer: undefined }, deployed)).toThrow(
      'origin_missing',
    );
    expect(() =>
      checkOrigin(
        { origin: undefined, referer: undefined },
        { trustedOrigins: TRUSTED, appEnv: 'test' },
      ),
    ).not.toThrow();
  });

  it('compares the token', () => {
    expect(() => checkToken('abc', 'abc')).not.toThrow();
    expect(() => checkToken('abc', undefined)).toThrow('token_missing');
    expect(() => checkToken('abc', '')).toThrow('token_missing');
    expect(() => checkToken('abc', 'abd')).toThrow('token_mismatch');
    expect(() => checkToken('abc', 'abcd')).toThrow('token_mismatch');
  });
});

describe('session tokens and records', () => {
  it('mints 43-character URL-safe tokens and hashes them with sha256', () => {
    const token = newToken();
    expect(isWellFormedToken(token)).toBe(true);
    expect(newToken()).not.toBe(token);
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(isWellFormedToken('short')).toBe(false);
  });

  const record = {
    user_id: '6F1C3C2E-0B39-4E0C-9A51-3C1A2B3C4D5E',
    telegram_user_id: 42,
    csrf_token: 'csrf',
    auth_method: 'telegram_oidc',
    created_at: 1,
    last_rotated_at: 1,
    entrance: 'admin',
  };

  it('round-trips a record and normalises the user id', () => {
    expect(parseSessionData(record).user_id).toBe('6f1c3c2e-0b39-4e0c-9a51-3c1a2b3c4d5e');
  });

  it.each([
    { ...record, auth_method: 'password' },
    { ...record, entrance: 'public' },
    { ...record, created_at: '1' },
    { ...record, csrf_token: '' },
    { ...record, user_id: 'nope' },
    [1, 2],
  ])('discards a malformed record', (bad) => {
    expect(decodeRecord(bad)).toBeNull();
  });

  it('accepts only well-formed tombstones', () => {
    const hash = 'a'.repeat(64);
    expect(decodeRecord({ rotated_to: hash })).toEqual({ kind: 'tombstone', rotatedTo: hash });
    expect(decodeRecord({ rotated_to: 'A'.repeat(64) })).toBeNull();
    expect(decodeRecord({ rotated_to: 42 })).toBeNull();
  });
});

describe('rate limit windows', () => {
  it('computes the fixed window and Retry-After', () => {
    expect(windowFor(125.5, 60)).toEqual([120, 55]);
    expect(windowFor(179.9, 60)).toEqual([120, 1]);
    expect(windowFor(180, 60)).toEqual([180, 60]);
    expect(rateLimitKey('auth_login', '203.0.113.1', 120)).toBe('auth_login:203.0.113.1:120');
  });
});

describe('MM-SVC-V1 signing', () => {
  it('builds the 8-line canonical string', () => {
    expect(
      canonicalString({
        keyId: 'tg',
        timestamp: '1700000000',
        nonce: 'n'.repeat(16),
        method: 'post',
        path: '/api/v1/x?a=1',
        actor: 'tg:42',
        body: new TextEncoder().encode('{}'),
      }),
    ).toBe(
      [
        'MM-SVC-V1',
        'tg',
        '1700000000',
        'n'.repeat(16),
        'POST',
        '/api/v1/x?a=1',
        'tg:42',
        '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      ].join('\n'),
    );
  });

  it('matches the Telegram service signer byte for byte', async () => {
    const { signRequest } = await import('../../../../telegram/tgcloud/lib/coreApi/signer.js');
    const secret = 's'.repeat(40);
    const nonce = 'abcdefghijklmnop';
    const theirs = await signRequest({
      keyId: 'tg',
      secret,
      method: 'POST',
      pathWithQuery: '/api/v1/internal/telegram/session',
      actor: 'tg:7',
      body: '{"a":1}',
      timestamp: 1700000000,
      nonce,
    });
    const ours = sign({
      secret,
      keyId: 'tg',
      timestamp: '1700000000',
      nonce,
      method: 'POST',
      path: '/api/v1/internal/telegram/session',
      actor: 'tg:7',
      body: new TextEncoder().encode('{"a":1}'),
    });
    expect(Object.values(theirs)).toContain(ours);
  });

  const keys = new Map([['tg', 's'.repeat(40)]]);
  const now = 1_700_000_000;

  it.each([
    [{ 'x-mm-key-id': 'bad key' }, 'malformed_headers'],
    [{ 'x-mm-nonce': 'short' }, 'malformed_headers'],
    [{ 'x-mm-signature': 'A'.repeat(64) }, 'malformed_headers'],
    [{ 'x-mm-actor': 'tg:0' }, 'malformed_actor'],
    [{ 'x-mm-actor': 'user:1' }, 'malformed_actor'],
    [{ 'x-mm-key-id': 'other' }, 'unknown_key'],
    [{ 'x-mm-timestamp': String(now - MAX_SKEW_SECONDS - 1) }, 'timestamp_skew'],
    [{ 'x-mm-timestamp': String(now + MAX_SKEW_SECONDS + 1) }, 'timestamp_skew'],
  ])('prechecks %o -> %s', (override, reason) => {
    const headers = new Headers({
      ...signedHeaders({ method: 'POST', path: '/x', secret: 's'.repeat(40), timestamp: now }),
      ...override,
    });
    try {
      precheck(headers, keys, now);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceAuthError);
      expect((error as ServiceAuthError).reason).toBe(reason);
    }
  });

  it('accepts the edge of the skew window', () => {
    const headers = new Headers(
      signedHeaders({
        method: 'GET',
        path: '/x',
        secret: 's'.repeat(40),
        timestamp: now - MAX_SKEW_SECONDS,
      }),
    );
    expect(precheck(headers, keys, now).keyId).toBe('tg');
  });
});

describe('outbox retry schedule', () => {
  it('backs off exponentially up to an hour', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(retryDelaySeconds)).toEqual([
      30, 60, 120, 240, 480, 960, 1920, 3600, 3600,
    ]);
    expect(retryDelaySeconds(0)).toBe(30);
  });
});
