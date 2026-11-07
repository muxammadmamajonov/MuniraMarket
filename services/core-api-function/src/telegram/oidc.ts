import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto';
import type { Settings } from '../config.ts';
import type { Clock, FetchFn } from '../http/context.ts';
import { constantTimeEqual } from '../security/tokens.ts';
import { truncateCodePoints, type VerifiedTelegramIdentity } from './identity.ts';

/**
 * Telegram OpenID Connect sign-in for browsers (port of services/api/app/telegram/oidc.py,
 * ADR 0014): Authorization Code flow with PKCE (S256). The code is exchanged at the token endpoint
 * with HTTP Basic client authentication and the PKCE verifier; the `id_token` is verified here
 * with node:crypto: RS256 only (no `alg` negotiation), Telegram's JWKS, `iss`, `aud`/`azp`,
 * `exp`, `iat` and `nonce`. The numeric Telegram user id is the `id` claim (`sub` is unused).
 * Responses are never logged: they hold tokens.
 */

export const CALLBACK_PATH = '/api/v1/auth/telegram/oidc/callback';
export const SCOPE = 'openid profile';
export const ALGORITHM = 'RS256';
export const LEEWAY_SECONDS = 60;
export const HTTP_TIMEOUT_MS = 10_000;
export const JWKS_TTL_SECONDS = 3600;
export const JWKS_REFRESH_MIN_INTERVAL_SECONDS = 60;
export const MAX_ID_TOKEN_BYTES = 16 * 1024;

const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const KID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const CODE_RE = /^[A-Za-z0-9._~+/=-]{1,1024}$/;
const MAX_NAME_LENGTH = 255;
const MAX_USERNAME_LENGTH = 64;

/** Sign-in failed. `reason` is a short, non-sensitive log label (never token content). */
export class OidcError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'OidcError';
    this.reason = reason;
  }
}

export interface OidcEndpoints {
  issuer: string;
  authorization: string;
  token: string;
  jwks: string;
}

export function oidcEndpoints(issuer: string): OidcEndpoints {
  return {
    issuer,
    authorization: `${issuer}/auth`,
    token: `${issuer}/token`,
    jwks: `${issuer}/.well-known/jwks.json`,
  };
}

// --- PKCE, state, nonce -------------------------------------------------------------------------

export function b64urlEncode(raw: Uint8Array): string {
  return Buffer.from(raw).toString('base64url');
}

export function b64urlDecode(text: string): Buffer {
  if (!B64URL_RE.test(text) || text.length % 4 === 1) throw new OidcError('token_malformed');
  return Buffer.from(text, 'base64url');
}

/** RFC 7636: 43-128 characters; 64 random bytes give 86. */
export function newCodeVerifier(): string {
  return randomBytes(64).toString('base64url');
}

export function codeChallenge(verifier: string): string {
  return b64urlEncode(createHash('sha256').update(verifier, 'ascii').digest());
}

/** `state`, `nonce` and the browser binding value: 256 random bits each. */
export function newSecretValue(): string {
  return randomBytes(32).toString('base64url');
}

export function isPlausibleCode(code: string): boolean {
  return CODE_RE.test(code);
}

/** Python's `urllib.parse.quote_plus` (what `urlencode` uses). */
function quotePlus(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

export function authorizationUrl(
  endpoints: OidcEndpoints,
  options: {
    clientId: number;
    redirectUri: string;
    state: string;
    nonce: string;
    verifier: string;
  },
): string {
  const params: Array<[string, string]> = [
    ['response_type', 'code'],
    ['client_id', String(options.clientId)],
    ['redirect_uri', options.redirectUri],
    ['scope', SCOPE],
    ['state', options.state],
    ['nonce', options.nonce],
    ['code_challenge', codeChallenge(options.verifier)],
    ['code_challenge_method', 'S256'],
  ];
  const query = params.map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`).join('&');
  return `${endpoints.authorization}?${query}`;
}

// --- token endpoint and JWKS --------------------------------------------------------------------

export interface OidcProvider {
  /** The `id_token` for `code`, or `OidcError`. */
  exchangeCode(options: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<string>;
  /** The RS256 key with id `kid` from the provider's JWKS, or `OidcError`. */
  signingKey(kid: string): Promise<KeyObject>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bitLength(bytes: Buffer): number {
  let index = 0;
  while (index < bytes.length && bytes[index] === 0) index += 1;
  if (index === bytes.length) return 0;
  const first = bytes[index] ?? 0;
  return (bytes.length - index - 1) * 8 + (32 - Math.clz32(first));
}

export function rsaKeyFromJwk(jwk: Record<string, unknown>): KeyObject {
  if (jwk['kty'] !== 'RSA' || (jwk['alg'] ?? ALGORITHM) !== ALGORITHM) {
    throw new OidcError('jwk_not_rs256');
  }
  if ((jwk['use'] ?? 'sig') !== 'sig') throw new OidcError('jwk_not_signing');
  const n = jwk['n'];
  const e = jwk['e'];
  if (typeof n !== 'string' || typeof e !== 'string') throw new OidcError('jwk_malformed');
  const modulus = b64urlDecode(n);
  b64urlDecode(e);
  if (bitLength(modulus) < 2048) throw new OidcError('jwk_too_small');
  try {
    return createPublicKey({ key: { kty: 'RSA', n, e }, format: 'jwk' });
  } catch {
    throw new OidcError('jwk_malformed');
  }
}

/** Talks to Telegram over HTTPS through `deps.fetch`. Keeps a per-instance JWKS cache. */
export class HttpOidcProvider implements OidcProvider {
  private keys = new Map<string, KeyObject>();
  private fetchedAt: number | null = null;

  constructor(
    private readonly options: {
      endpoints: OidcEndpoints;
      clientId: number;
      clientSecret: string;
      clock: Clock;
      fetch: FetchFn;
    },
  ) {}

  private async request(url: string, init: RequestInit): Promise<Response> {
    return this.options.fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: {
        accept: 'application/json',
        'user-agent': 'muniramarket-core-api',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  }

  async exchangeCode(options: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<string> {
    const clientId = String(this.options.clientId);
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: options.code,
      redirect_uri: options.redirectUri,
      client_id: clientId,
      code_verifier: options.codeVerifier,
    });
    const basic = Buffer.from(`${clientId}:${this.options.clientSecret}`, 'latin1').toString(
      'base64',
    );
    let response: Response;
    try {
      response = await this.request(this.options.endpoints.token, {
        method: 'POST',
        body: form.toString(),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${basic}`,
        },
      });
    } catch {
      throw new OidcError('token_endpoint_unreachable');
    }
    if (response.status !== 200) throw new OidcError(`token_endpoint_${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new OidcError('token_response_not_json');
    }
    const idToken = isRecord(body) ? body['id_token'] : undefined;
    if (typeof idToken !== 'string' || idToken === '') {
      throw new OidcError('token_response_without_id_token');
    }
    return idToken;
  }

  private async refresh(): Promise<void> {
    let response: Response;
    try {
      response = await this.request(this.options.endpoints.jwks, { method: 'GET' });
    } catch {
      throw new OidcError('jwks_unreachable');
    }
    if (response.status !== 200) throw new OidcError(`jwks_${response.status}`);
    let document: unknown;
    try {
      document = await response.json();
    } catch {
      throw new OidcError('jwks_not_json');
    }
    const rawKeys = isRecord(document) ? document['keys'] : undefined;
    if (!Array.isArray(rawKeys)) throw new OidcError('jwks_malformed');
    const keys = new Map<string, KeyObject>();
    for (const jwk of rawKeys) {
      // Telegram also publishes an ES256 key; only RS256 is accepted here.
      if (!isRecord(jwk) || jwk['kty'] !== 'RSA') continue;
      const kid = jwk['kid'];
      if (typeof kid !== 'string' || !KID_RE.test(kid)) continue;
      try {
        keys.set(kid, rsaKeyFromJwk(jwk));
      } catch {
        continue;
      }
    }
    this.keys = keys;
    this.fetchedAt = this.options.clock();
  }

  async signingKey(kid: string): Promise<KeyObject> {
    const now = this.options.clock();
    const stale = this.fetchedAt === null || now - this.fetchedAt > JWKS_TTL_SECONDS;
    const mayRefresh =
      this.fetchedAt === null || now - this.fetchedAt > JWKS_REFRESH_MIN_INTERVAL_SECONDS;
    if (stale || (!this.keys.has(kid) && mayRefresh)) await this.refresh();
    const key = this.keys.get(kid);
    if (key === undefined) throw new OidcError('unknown_kid');
    return key;
  }
}

// --- id_token verification ----------------------------------------------------------------------

function jsonSegment(segment: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b64urlDecode(segment)));
  } catch (error) {
    if (error instanceof OidcError) throw error;
    throw new OidcError('token_malformed');
  }
  if (!isRecord(value)) throw new OidcError('token_malformed');
  return value;
}

function intClaim(claims: Record<string, unknown>, name: string): number {
  const value = claims[name];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new OidcError(`claim_${name}_invalid`);
  }
  return value;
}

function optionalText(claims: Record<string, unknown>, name: string, max: number): string | null {
  const value = claims[name];
  if (typeof value !== 'string') return null;
  const stripped = value.trim();
  return stripped === '' ? null : truncateCodePoints(stripped, max);
}

/** The `kid` of an RS256 token. Refuses every other algorithm up front. */
export function unverifiedKid(idToken: string): string {
  if (idToken.length > MAX_ID_TOKEN_BYTES || idToken.split('.').length !== 3) {
    throw new OidcError('token_malformed');
  }
  const header = jsonSegment(idToken.split('.', 1)[0] ?? '');
  if (header['alg'] !== ALGORITHM) throw new OidcError('alg_not_rs256');
  const kid = header['kid'];
  if (typeof kid !== 'string' || !KID_RE.test(kid)) throw new OidcError('kid_missing');
  return kid;
}

function pythonStr(value: unknown): string {
  if (value === true) return 'True';
  if (value === false) return 'False';
  return String(value);
}

export function verifyIdToken(
  idToken: string,
  options: { key: KeyObject; issuer: string; clientId: number; nonce: string; now: number },
): VerifiedTelegramIdentity {
  unverifiedKid(idToken);
  const [headerB64 = '', payloadB64 = '', signatureB64 = ''] = idToken.split('.');
  const signature = b64urlDecode(signatureB64);
  const signed = `${headerB64}.${payloadB64}`;
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7f]*$/.test(signed)) throw new OidcError('token_malformed');
  let valid = false;
  try {
    valid = verify('sha256', Buffer.from(signed, 'ascii'), options.key, signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new OidcError('bad_signature');
  const claims = jsonSegment(payloadB64);

  if (claims['iss'] !== options.issuer) throw new OidcError('iss_mismatch');
  const audience = claims['aud'];
  const expected = String(options.clientId);
  const audiences = Array.isArray(audience) ? audience : [audience];
  if (
    !audiences.some((item) => item !== null && item !== undefined && pythonStr(item) === expected)
  ) {
    throw new OidcError('aud_mismatch');
  }
  if (Array.isArray(audience) && audience.length > 1) {
    const azp = claims['azp'];
    if (azp === null || azp === undefined || pythonStr(azp) !== expected) {
      throw new OidcError('azp_mismatch');
    }
  }
  if (intClaim(claims, 'exp') <= options.now - LEEWAY_SECONDS) throw new OidcError('expired');
  const issuedAt = intClaim(claims, 'iat');
  if (issuedAt > options.now + LEEWAY_SECONDS) throw new OidcError('iat_in_future');
  const receivedNonce = claims['nonce'];
  if (typeof receivedNonce !== 'string' || !constantTimeEqual(receivedNonce, options.nonce)) {
    throw new OidcError('nonce_mismatch');
  }

  const telegramUserId = intClaim(claims, 'id');
  if (telegramUserId <= 0 || !Number.isSafeInteger(telegramUserId)) {
    throw new OidcError('claim_id_invalid');
  }
  const firstName =
    optionalText(claims, 'given_name', MAX_NAME_LENGTH) ??
    optionalText(claims, 'name', MAX_NAME_LENGTH);
  if (firstName === null) throw new OidcError('claim_name_missing');
  return {
    telegramUserId,
    firstName,
    lastName: optionalText(claims, 'family_name', MAX_NAME_LENGTH),
    username: optionalText(claims, 'preferred_username', MAX_USERNAME_LENGTH),
    languageCode: null,
    authDate: issuedAt,
  };
}

/** Everything the routes need: configuration plus the provider (network or fake). */
export class OidcClient {
  constructor(
    readonly endpoints: OidcEndpoints,
    readonly clientId: number,
    readonly provider: OidcProvider,
    readonly stateTtlSeconds: number,
  ) {}

  async identityFor(options: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    nonce: string;
    now: number;
  }): Promise<VerifiedTelegramIdentity> {
    const idToken = await this.provider.exchangeCode({
      code: options.code,
      redirectUri: options.redirectUri,
      codeVerifier: options.codeVerifier,
    });
    const key = await this.provider.signingKey(unverifiedKid(idToken));
    return verifyIdToken(idToken, {
      key,
      issuer: this.endpoints.issuer,
      clientId: this.clientId,
      nonce: options.nonce,
      now: options.now,
    });
  }
}

/** `null` unless Telegram OIDC sign-in is fully configured. */
export function buildOidcClient(
  settings: Settings,
  clock: Clock,
  fetchFn: FetchFn,
): OidcClient | null {
  if (
    !settings.telegramOidcEnabled ||
    settings.telegramOidcClientId === null ||
    settings.telegramOidcClientSecret === null
  ) {
    return null;
  }
  const endpoints = oidcEndpoints(settings.telegramOidcIssuer);
  return new OidcClient(
    endpoints,
    settings.telegramOidcClientId,
    new HttpOidcProvider({
      endpoints,
      clientId: settings.telegramOidcClientId,
      clientSecret: settings.telegramOidcClientSecret,
      clock,
      fetch: fetchFn,
    }),
    settings.telegramOidcStateTtlSeconds,
  );
}
