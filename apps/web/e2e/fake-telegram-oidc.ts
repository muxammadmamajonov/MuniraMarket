import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';

/**
 * A fake Telegram OpenID Connect provider for the E2E run. TEST USE ONLY, dependency-free, never
 * deployed. It lets the admin specs sign in through the real browser flow without a Telegram
 * account: app button -> Core API `oidc/start` -> this server's `/auth` -> the API's callback ->
 * the API exchanges the code at this server's `/token` (server to server) and verifies the
 * `id_token` against `/.well-known/jwks.json` -> back to the app, signed in.
 *
 * It mirrors what the Core API expects from Telegram (`services/api/app/telegram/oidc.py`):
 * Authorization Code + PKCE (S256), HTTP Basic client authentication at the token endpoint, and an
 * RS256 `id_token` (kid `e2e-1`, a fresh RSA-2048 key per process) with `iss`, `aud` (the client id
 * as a string), `sub`, `iat`, `exp`, `nonce`, the numeric Telegram `id`, `name`, `given_name`,
 * `family_name` and `preferred_username`.
 *
 * Configuration (environment; the values are throw-away test values, never real credentials):
 * - `E2E_OIDC_CLIENT_ID`      numeric client id the Core API under test is configured with;
 * - `E2E_OIDC_CLIENT_SECRET`  its client secret (generated per CI run);
 * - `E2E_ADMIN_TELEGRAM_ID`   Telegram id of the user every login signs in as;
 * - `E2E_OIDC_PORT`           listen port on 127.0.0.1 (default 8899); the issuer is
 *                             `http://127.0.0.1:<port>`;
 * - `E2E_OIDC_REDIRECT_ORIGINS` comma-separated origins whose `/api/v1/auth/telegram/oidc/callback`
 *                             may be used as `redirect_uri` (default
 *                             `http://localhost:3000,http://localhost:3001`).
 *
 * Test-only query parameters of `/auth` (ignored unless present): `e2e_telegram_id` signs in as
 * another numeric id; `e2e_outcome=cancel` answers like a user who declined
 * (`error=access_denied`).
 *
 * Run:         node e2e/fake-telegram-oidc.ts
 * Self-check:  node e2e/fake-telegram-oidc.ts --self-check   (starts on a random port, runs the
 *              whole flow with `fetch`, exits non-zero on failure)
 */

export const DEFAULT_PORT = 8899;
export const KEY_ID = 'e2e-1';
const CALLBACK_PATH = '/api/v1/auth/telegram/oidc/callback';
const CODE_TTL_MS = 60_000;
const ID_TOKEN_TTL_SECONDS = 3600;
const MAX_BODY_BYTES = 16 * 1024;
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface FakeOidcUser {
  id: number;
  givenName: string;
  familyName: string;
  username: string;
}

export interface FakeOidcOptions {
  clientId: string;
  clientSecret: string;
  user: FakeOidcUser;
  /** 0 picks a free port (self-check). */
  port?: number;
  redirectOrigins?: readonly string[];
  /** Seconds since the epoch; tests may pin it. */
  now?: () => number;
}

export interface FakeOidcServer {
  issuer: string;
  server: Server;
  close: () => Promise<void>;
}

interface PendingCode {
  redirectUri: string;
  challenge: string;
  nonce: string;
  user: FakeOidcUser;
  expiresAt: number;
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url');
}

function s256(verifier: string): string {
  return b64url(createHash('sha256').update(verifier, 'ascii').digest());
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function signJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key: KeyObject,
): string {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = sign('sha256', Buffer.from(input, 'ascii'), key);
  return `${input}.${b64url(signature)}`;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(text);
}

async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** `Authorization: Basic base64(client_id:client_secret)` -> the pair, or `null`. */
function basicCredentials(header: string | undefined): [string, string] | null {
  const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header ?? '');
  if (match?.[1] === undefined) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  // RFC 6749 2.3.1: both parts are form-urlencoded before base64.
  try {
    return [
      decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' ')),
      decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' ')),
    ];
  } catch {
    return null;
  }
}

export function startFakeTelegramOidc(options: FakeOidcOptions): Promise<FakeOidcServer> {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const redirectOrigins = options.redirectOrigins ?? [
    'http://localhost:3000',
    'http://localhost:3001',
  ];
  const allowedRedirects = new Set(redirectOrigins.map((origin) => `${origin}${CALLBACK_PATH}`));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const codes = new Map<string, PendingCode>();
  let issuer = '';

  function authorize(url: URL, response: ServerResponse): void {
    const q = url.searchParams;
    const redirectUri = q.get('redirect_uri') ?? '';
    // Like a real provider: never redirect to an unregistered URI, answer with an error page.
    if (!allowedRedirects.has(redirectUri)) {
      sendText(response, 400, 'invalid redirect_uri');
      return;
    }
    const state = q.get('state') ?? '';
    const nonce = q.get('nonce') ?? '';
    const challenge = q.get('code_challenge') ?? '';
    const scopes = (q.get('scope') ?? '').split(' ');
    const problems = [
      q.get('response_type') === 'code' ? null : 'response_type',
      q.get('client_id') === options.clientId ? null : 'client_id',
      scopes.includes('openid') ? null : 'scope',
      state === '' ? 'state' : null,
      nonce === '' ? 'nonce' : null,
      CHALLENGE_PATTERN.test(challenge) ? null : 'code_challenge',
      q.get('code_challenge_method') === 'S256' ? null : 'code_challenge_method',
    ].filter((problem): problem is string => problem !== null);
    if (problems.length > 0) {
      sendText(response, 400, `invalid request: ${problems.join(', ')}`);
      return;
    }

    const target = new URL(redirectUri);
    if (q.get('e2e_outcome') === 'cancel') {
      target.searchParams.set('error', 'access_denied');
      target.searchParams.set('state', state);
    } else {
      const overrideId = Number(q.get('e2e_telegram_id'));
      const user =
        q.has('e2e_telegram_id') && Number.isSafeInteger(overrideId) && overrideId > 0
          ? { ...options.user, id: overrideId }
          : options.user;
      const code = b64url(randomBytes(32));
      codes.set(code, {
        redirectUri,
        challenge,
        nonce,
        user,
        expiresAt: Date.now() + CODE_TTL_MS,
      });
      target.searchParams.set('code', code);
      target.searchParams.set('state', state);
    }
    response.writeHead(302, { location: target.toString(), 'cache-control': 'no-store' });
    response.end();
  }

  async function token(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const credentials = basicCredentials(request.headers.authorization);
    if (
      credentials === null ||
      !safeEqual(credentials[0], options.clientId) ||
      !safeEqual(credentials[1], options.clientSecret)
    ) {
      response.setHeader('www-authenticate', 'Basic realm="fake-telegram-oidc"');
      sendJson(response, 401, { error: 'invalid_client' });
      return;
    }
    if (!(request.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
      sendJson(response, 400, { error: 'invalid_request' });
      return;
    }
    const raw = await readBody(request);
    if (raw === null) {
      sendJson(response, 413, { error: 'invalid_request' });
      return;
    }
    const form = new URLSearchParams(raw);
    if (form.get('grant_type') !== 'authorization_code') {
      sendJson(response, 400, { error: 'unsupported_grant_type' });
      return;
    }
    const formClientId = form.get('client_id');
    if (formClientId !== null && formClientId !== options.clientId) {
      sendJson(response, 401, { error: 'invalid_client' });
      return;
    }
    const code = form.get('code') ?? '';
    const pending = codes.get(code);
    // Single use: the code is gone after its first presentation, whatever the outcome.
    codes.delete(code);
    const verifier = form.get('code_verifier') ?? '';
    if (
      pending === undefined ||
      pending.expiresAt < Date.now() ||
      form.get('redirect_uri') !== pending.redirectUri ||
      !VERIFIER_PATTERN.test(verifier) ||
      !safeEqual(s256(verifier), pending.challenge)
    ) {
      sendJson(response, 400, { error: 'invalid_grant' });
      return;
    }

    const issuedAt = now();
    const { user } = pending;
    const idToken = signJwt(
      { alg: 'RS256', typ: 'JWT', kid: KEY_ID },
      {
        iss: issuer,
        aud: options.clientId,
        sub: `e2e-${createHash('sha256').update(String(user.id)).digest('hex').slice(0, 24)}`,
        iat: issuedAt,
        exp: issuedAt + ID_TOKEN_TTL_SECONDS,
        nonce: pending.nonce,
        id: user.id,
        name: `${user.givenName} ${user.familyName}`,
        given_name: user.givenName,
        family_name: user.familyName,
        preferred_username: user.username,
      },
      privateKey,
    );
    sendJson(response, 200, {
      access_token: 'x',
      token_type: 'Bearer',
      expires_in: ID_TOKEN_TTL_SECONDS,
      id_token: idToken,
    });
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const route = `${request.method ?? 'GET'} ${url.pathname}`;
    if (route === 'GET /auth') return authorize(url, response);
    if (route === 'POST /token') {
      token(request, response).catch(() => sendJson(response, 500, { error: 'server_error' }));
      return undefined;
    }
    if (route === 'GET /.well-known/jwks.json') {
      return sendJson(response, 200, {
        keys: [{ kty: 'RSA', kid: KEY_ID, use: 'sig', alg: 'RS256', n: jwk.n, e: jwk.e }],
      });
    }
    if (route === 'GET /.well-known/openid-configuration') {
      return sendJson(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/auth`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        response_types_supported: ['code'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });
    }
    if (route === 'GET /health') return sendText(response, 200, 'ok');
    return sendText(response, 404, 'not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? DEFAULT_PORT, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      issuer = `http://127.0.0.1:${String(port)}`;
      resolve({
        issuer,
        server,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

// --- CLI ------------------------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`Set ${name} (test-only value).`);
  return value;
}

function optionsFromEnv(): FakeOidcOptions {
  const clientId = requireEnv('E2E_OIDC_CLIENT_ID');
  if (!/^[1-9][0-9]{0,15}$/.test(clientId)) throw new Error('E2E_OIDC_CLIENT_ID must be numeric.');
  const telegramId = Number(requireEnv('E2E_ADMIN_TELEGRAM_ID'));
  if (!Number.isSafeInteger(telegramId) || telegramId <= 0) {
    throw new Error('E2E_ADMIN_TELEGRAM_ID must be a positive integer.');
  }
  const port = Number(process.env['E2E_OIDC_PORT'] ?? DEFAULT_PORT);
  const origins = process.env['E2E_OIDC_REDIRECT_ORIGINS'];
  return {
    clientId,
    clientSecret: requireEnv('E2E_OIDC_CLIENT_SECRET'),
    user: { id: telegramId, givenName: 'E2E', familyName: 'Admin', username: 'e2e_admin' },
    port,
    ...(origins === undefined || origins === ''
      ? {}
      : { redirectOrigins: origins.split(',').map((origin) => origin.trim()) }),
  };
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Runs the whole flow against a server on a random port, the way the Core API would. */
async function selfCheck(): Promise<void> {
  const clientId = '1234567890';
  const clientSecret = 'test-only-self-check-secret';
  const fake = await startFakeTelegramOidc({
    clientId,
    clientSecret,
    port: 0,
    user: { id: 990_000_001, givenName: 'E2E', familyName: 'Admin', username: 'e2e_admin' },
  });
  const failures: string[] = [];
  const check = (name: string, ok: boolean) => {
    if (!ok) failures.push(name);
  };
  const redirectUri = `http://localhost:3001${CALLBACK_PATH}`;
  const verifier = b64url(randomBytes(64));
  const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;

  const authorizeUrl = (overrides: Record<string, string> = {}) => {
    const url = new URL(`${fake.issuer}/auth`);
    const params = {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'openid profile',
      state: 'state-1',
      nonce: 'nonce-1',
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
      ...overrides,
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url;
  };
  const getCode = async (overrides: Record<string, string> = {}) => {
    const response = await fetch(authorizeUrl(overrides), { redirect: 'manual' });
    const location = new URL(response.headers.get('location') ?? 'http://invalid/');
    return { response, location, code: location.searchParams.get('code') ?? '' };
  };
  const exchange = (code: string, extra: Record<string, string> = {}, auth = basic) =>
    fetch(`${fake.issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: auth },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        ...extra,
      }),
    });

  try {
    const { response, location, code } = await getCode();
    check('authorize redirects 302', response.status === 302);
    check('redirect goes to redirect_uri', location.href.startsWith(`${redirectUri}?`));
    check('redirect carries state', location.searchParams.get('state') === 'state-1');
    check('redirect carries a code', code.length >= 43);

    const tokenResponse = await exchange(code);
    check('token endpoint answers 200', tokenResponse.status === 200);
    const body = (await tokenResponse.json()) as { id_token?: string; token_type?: string };
    check('token_type is Bearer', body.token_type === 'Bearer');
    const [header = '', payload = '', signature = ''] = (body.id_token ?? '').split('.');
    const jwks = (await (await fetch(`${fake.issuer}/.well-known/jwks.json`)).json()) as {
      keys: JsonWebKey[];
    };
    const key = createPublicKey({ key: jwks.keys[0] as JsonWebKey, format: 'jwk' });
    check(
      'id_token signature verifies against the JWKS (RS256)',
      verify(
        'sha256',
        Buffer.from(`${header}.${payload}`, 'ascii'),
        key,
        Buffer.from(signature, 'base64url'),
      ),
    );
    const head = decodeSegment(header);
    check(
      'header alg/typ/kid',
      head['alg'] === 'RS256' && head['typ'] === 'JWT' && head['kid'] === KEY_ID,
    );
    const claims = decodeSegment(payload);
    const issuedAt = Number(claims['iat']);
    check('iss', claims['iss'] === fake.issuer);
    check('aud is the client id string', claims['aud'] === clientId);
    check('nonce', claims['nonce'] === 'nonce-1');
    check('numeric id', claims['id'] === 990_000_001);
    check('given_name', claims['given_name'] === 'E2E');
    check('preferred_username', claims['preferred_username'] === 'e2e_admin');
    check('sub is opaque', typeof claims['sub'] === 'string' && claims['sub'] !== '990000001');
    check('exp = iat + 3600', Number(claims['exp']) === issuedAt + 3600);
    check('iat is current', Math.abs(issuedAt - Date.now() / 1000) < 5);

    check('a code is single-use', (await exchange(code)).status === 400);

    const second = await getCode();
    check(
      'a wrong PKCE verifier is refused',
      (await exchange(second.code, { code_verifier: b64url(randomBytes(64)) })).status === 400,
    );
    check('the refused code is burnt', (await exchange(second.code)).status === 400);

    const third = await getCode();
    const wrongSecret = `Basic ${Buffer.from(`${clientId}:nope`).toString('base64')}`;
    check(
      'a wrong client secret is refused',
      (await exchange(third.code, {}, wrongSecret)).status === 401,
    );
    const fourth = await getCode();
    check(
      'a different redirect_uri at the token endpoint is refused',
      (await exchange(fourth.code, { redirect_uri: `http://localhost:3000${CALLBACK_PATH}` }))
        .status === 400,
    );

    const badRedirect = await fetch(authorizeUrl({ redirect_uri: 'https://evil.test/cb' }), {
      redirect: 'manual',
    });
    check('an unregistered redirect_uri gets no redirect', badRedirect.status === 400);
    const plain = await fetch(authorizeUrl({ code_challenge_method: 'plain' }), {
      redirect: 'manual',
    });
    check('PKCE plain is refused', plain.status === 400);
    const noOpenid = await fetch(authorizeUrl({ scope: 'profile' }), { redirect: 'manual' });
    check('scope without openid is refused', noOpenid.status === 400);
    const wrongClient = await fetch(authorizeUrl({ client_id: '1' }), { redirect: 'manual' });
    check('an unknown client_id is refused', wrongClient.status === 400);

    const cancelled = await getCode({ e2e_outcome: 'cancel' });
    check(
      'e2e_outcome=cancel answers access_denied',
      cancelled.location.searchParams.get('error') === 'access_denied' && cancelled.code === '',
    );
  } finally {
    await fake.close();
  }

  if (failures.length > 0) {
    console.error(`fake-telegram-oidc self-check FAILED: ${failures.join('; ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('fake-telegram-oidc self-check passed');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--self-check')) {
    void selfCheck();
  } else {
    const options = optionsFromEnv();
    startFakeTelegramOidc(options).then(
      ({ issuer }) => {
        // Never log the secret or tokens.
        console.log(`fake Telegram OIDC provider listening on ${issuer}`);
      },
      (error: unknown) => {
        console.error(`fake Telegram OIDC provider failed to start: ${String(error)}`);
        process.exitCode = 1;
      },
    );
  }
}
