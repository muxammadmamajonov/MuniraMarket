import {
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import { sign } from '../../../src/security/serviceAuth.ts';
import {
  TEST_BOT_TOKEN,
  TEST_SCHEDULER_SECRET,
  TEST_SERVICE_KEY_ID,
  TEST_SERVICE_SECRET,
} from '../../helpers/harness.ts';

/** Test-only helpers shared by the security, Telegram and internal-route tests. */

export interface SignOptions {
  method: string;
  path: string;
  body?: string;
  actor?: string;
  keyId?: string;
  secret?: string;
  timestamp?: number;
  nonce?: string;
}

/** `X-MM-*` headers for an ADR 0003 signed request (defaults: the `tg` key, empty actor). */
export function signedHeaders(options: SignOptions): Record<string, string> {
  const keyId = options.keyId ?? TEST_SERVICE_KEY_ID;
  const secret =
    options.secret ?? (keyId === 'scheduler' ? TEST_SCHEDULER_SECRET : TEST_SERVICE_SECRET);
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? randomBytes(18).toString('base64url');
  const actor = options.actor ?? '';
  const signature = sign({
    secret,
    keyId,
    timestamp,
    nonce,
    method: options.method,
    path: options.path,
    actor,
    body: new TextEncoder().encode(options.body ?? ''),
  });
  const headers: Record<string, string> = {
    'x-mm-key-id': keyId,
    'x-mm-timestamp': timestamp,
    'x-mm-nonce': nonce,
    'x-mm-signature': signature,
  };
  if (actor !== '') headers['x-mm-actor'] = actor;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return headers;
}

/** Mini App initData signed with the test bot token (HMAC validation). */
export function hmacInitData(
  user: Record<string, unknown>,
  options: { authDate?: number; extra?: Record<string, string>; token?: string } = {},
): string {
  const fields: Record<string, string> = {
    auth_date: String(options.authDate ?? Math.floor(Date.now() / 1000)),
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: JSON.stringify(user),
    ...options.extra,
  };
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData')
    .update(options.token ?? TEST_BOT_TOKEN)
    .digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

export const OIDC_KID = 'test-kid-1';

export interface RsaSigner {
  privateKey: KeyObject;
  publicJwk: Record<string, unknown>;
  token(claims: Record<string, unknown>, header?: Record<string, unknown>): string;
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

export function rsaSigner(kid: string = OIDC_KID, modulusLength = 2048): RsaSigner {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return {
    privateKey,
    publicJwk: { ...jwk, kid, alg: 'RS256', use: 'sig' },
    token(claims, header = { alg: 'RS256', kid, typ: 'JWT' }) {
      const signed = `${b64(header)}.${b64(claims)}`;
      const signature = cryptoSign('sha256', Buffer.from(signed), privateKey).toString('base64url');
      return `${signed}.${signature}`;
    },
  };
}
