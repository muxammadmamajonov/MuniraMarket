import { describe, expect, it } from 'vitest';
import {
  authorizationUrl,
  codeChallenge,
  HttpOidcProvider,
  OidcError,
  oidcEndpoints,
  rsaKeyFromJwk,
  verifyIdToken,
} from '../../../src/telegram/oidc.ts';
import { OIDC_KID, rsaSigner } from '../security/helpers.ts';

const ISSUER = 'https://oauth.telegram.org';
const CLIENT_ID = 777;
const NOW = 1_700_000_000;
const signer = rsaSigner();
const key = rsaKeyFromJwk(signer.publicJwk);

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: String(CLIENT_ID),
    sub: 'opaque',
    id: 4242,
    exp: NOW + 300,
    iat: NOW,
    nonce: 'nonce-1',
    given_name: 'Munira',
    family_name: 'K',
    preferred_username: 'munira',
    ...overrides,
  };
}

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof OidcError) return error.reason;
    throw error;
  }
  return 'ok';
}

const verify = (token: string) =>
  verifyIdToken(token, { key, issuer: ISSUER, clientId: CLIENT_ID, nonce: 'nonce-1', now: NOW });

describe('id_token verification', () => {
  it('yields the Telegram id claim, not sub', () => {
    expect(verify(signer.token(claims()))).toEqual({
      telegramUserId: 4242,
      firstName: 'Munira',
      lastName: 'K',
      username: 'munira',
      languageCode: null,
      authDate: NOW,
    });
    expect(verify(signer.token(claims({ given_name: ' ', name: 'Full Name' }))).firstName).toBe(
      'Full Name',
    );
    expect(verify(signer.token(claims({ id: '4242' }))).telegramUserId).toBe(4242);
  });

  it.each([
    [{ iss: 'https://evil.example' }, 'iss_mismatch'],
    [{ aud: '1' }, 'aud_mismatch'],
    [{ aud: [String(CLIENT_ID), 'other'] }, 'azp_mismatch'],
    [{ exp: NOW - 61 }, 'expired'],
    [{ iat: NOW + 61 }, 'iat_in_future'],
    [{ nonce: 'other' }, 'nonce_mismatch'],
    [{ id: 0 }, 'claim_id_invalid'],
    [{ id: '004242' }, 'claim_id_invalid'],
    [{ id: 'not-a-telegram-id' }, 'claim_id_invalid'],
    [{ id: '9007199254740992' }, 'claim_id_invalid'],
    [{ given_name: undefined, name: undefined }, 'claim_name_missing'],
  ])('checks claims %o', (override, expected) => {
    expect(reason(() => verify(signer.token(claims(override))))).toBe(expected);
  });

  it('allows 60 s of leeway and an azp audience list', () => {
    expect(reason(() => verify(signer.token(claims({ exp: NOW - 59 }))))).toBe('ok');
    expect(
      reason(() => verify(signer.token(claims({ aud: [String(CLIENT_ID), 'x'], azp: CLIENT_ID })))),
    ).toBe('ok');
  });

  it('refuses another key, a tampered payload and other algorithms', () => {
    expect(reason(() => verify(rsaSigner().token(claims())))).toBe('bad_signature');
    const [h, , s] = signer.token(claims()).split('.');
    const forged = Buffer.from(JSON.stringify(claims({ id: 1 }))).toString('base64url');
    expect(reason(() => verify(`${h}.${forged}.${s}`))).toBe('bad_signature');
    expect(reason(() => verify(signer.token(claims(), { alg: 'none', kid: OIDC_KID })))).toBe(
      'alg_not_rs256',
    );
    expect(reason(() => verify(signer.token(claims(), { alg: 'HS256', kid: OIDC_KID })))).toBe(
      'alg_not_rs256',
    );
    expect(reason(() => verify(signer.token(claims(), { alg: 'RS256' })))).toBe('kid_missing');
    expect(reason(() => verify('a.b'))).toBe('token_malformed');
    expect(reason(() => verify('!!.b.c'))).toBe('token_malformed');
  });
});

describe('PKCE and the authorization request', () => {
  it('matches RFC 7636 appendix B', () => {
    expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('builds the URL like urlencode', () => {
    const url = new URL(
      authorizationUrl(oidcEndpoints(ISSUER), {
        clientId: CLIENT_ID,
        redirectUri: 'https://shop.example/api/v1/auth/telegram/oidc/callback',
        state: 's',
        nonce: 'n',
        verifier: 'v'.repeat(43),
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/auth`);
    expect(url.search).toContain('redirect_uri=https%3A%2F%2Fshop.example%2Fapi%2Fv1');
    expect(url.search).toContain('scope=openid+profile');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('JWK parsing', () => {
  it('refuses weak or foreign keys', () => {
    expect(reason(() => rsaKeyFromJwk({ ...signer.publicJwk, kty: 'EC' }))).toBe('jwk_not_rs256');
    expect(reason(() => rsaKeyFromJwk({ ...signer.publicJwk, alg: 'RS512' }))).toBe(
      'jwk_not_rs256',
    );
    expect(reason(() => rsaKeyFromJwk({ ...signer.publicJwk, use: 'enc' }))).toBe(
      'jwk_not_signing',
    );
    expect(reason(() => rsaKeyFromJwk({ ...signer.publicJwk, n: 5 }))).toBe('jwk_malformed');
    expect(reason(() => rsaKeyFromJwk(rsaSigner('k', 1024).publicJwk))).toBe('jwk_too_small');
  });
});

describe('HttpOidcProvider over deps.fetch', () => {
  function provider(handler: (url: string, init: RequestInit) => Response, clock = () => NOW) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const instance = new HttpOidcProvider({
      endpoints: oidcEndpoints(ISSUER),
      clientId: CLIENT_ID,
      clientSecret: 'client-secret',
      clock,
      fetch: async (input, init = {}) => {
        calls.push({ url: String(input), init });
        return handler(String(input), init);
      },
    });
    return { instance, calls };
  }

  it('exchanges the code with Basic auth and the PKCE verifier', async () => {
    const { instance, calls } = provider(() => Response.json({ id_token: 'tok' }));
    await expect(
      instance.exchangeCode({ code: 'c', redirectUri: 'https://x/cb', codeVerifier: 'ver' }),
    ).resolves.toBe('tok');
    const [call] = calls;
    expect(call?.url).toBe(`${ISSUER}/token`);
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:client-secret`).toString('base64')}`,
    );
    const form = new URLSearchParams(String(call?.init.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      code: 'c',
      redirect_uri: 'https://x/cb',
      client_id: String(CLIENT_ID),
      code_verifier: 'ver',
    });
    expect(String(call?.init.body)).not.toContain('client-secret');
  });

  it.each([
    [() => new Response('no', { status: 400 }), 'token_endpoint_400'],
    [() => new Response('not json'), 'token_response_not_json'],
    [() => Response.json({}), 'token_response_without_id_token'],
    [
      () => {
        throw new TypeError('network');
      },
      'token_endpoint_unreachable',
    ],
  ])('maps exchange failures', async (handler, expected) => {
    const { instance } = provider(handler);
    const error = await instance
      .exchangeCode({ code: 'c', redirectUri: 'r', codeVerifier: 'v' })
      .catch((e: unknown) => e);
    expect((error as OidcError).reason).toBe(expected);
  });

  it('caches the JWKS and refreshes for unknown kids at most once a minute', async () => {
    let now = NOW;
    const { instance, calls } = provider(
      () => Response.json({ keys: [{ kty: 'EC', kid: 'ec' }, signer.publicJwk] }),
      () => now,
    );
    await instance.signingKey(OIDC_KID);
    await instance.signingKey(OIDC_KID);
    expect(calls).toHaveLength(1);
    await expect(instance.signingKey('unknown')).rejects.toThrow('unknown_kid');
    expect(calls).toHaveLength(1);
    now += 61;
    await expect(instance.signingKey('unknown')).rejects.toThrow('unknown_kid');
    expect(calls).toHaveLength(2);
    now += 3601;
    await instance.signingKey(OIDC_KID);
    expect(calls).toHaveLength(3);
  });
});
