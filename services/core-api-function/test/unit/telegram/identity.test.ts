import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  Ed25519InitDataVerifier,
  HmacInitDataVerifier,
  InvalidInitData,
  parseInitData,
} from '../../../src/telegram/identity.ts';
import { TEST_BOT_TOKEN } from '../../helpers/harness.ts';
import { hmacInitData } from '../security/helpers.ts';

const NOW = 1_700_000_000;
const clock = () => NOW;
const USER = {
  id: 42,
  first_name: '  Munira ',
  last_name: 'K',
  username: 'munira',
  language_code: 'ru',
};

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof InvalidInitData) return error.reason;
    throw error;
  }
  return 'ok';
}

describe('HMAC initData validation', () => {
  const verifier = new HmacInitDataVerifier({
    botToken: TEST_BOT_TOKEN,
    maxAgeSeconds: 3600,
    clock,
  });

  it('accepts valid initData and normalises the profile', () => {
    expect(verifier.verify(hmacInitData(USER, { authDate: NOW - 10 }))).toEqual({
      telegramUserId: 42,
      firstName: 'Munira',
      lastName: 'K',
      username: 'munira',
      languageCode: 'ru',
      authDate: NOW - 10,
    });
  });

  it('rejects expired, future-dated and tampered data', () => {
    expect(reason(() => verifier.verify(hmacInitData(USER, { authDate: NOW - 3601 })))).toBe(
      'expired',
    );
    expect(reason(() => verifier.verify(hmacInitData(USER, { authDate: NOW + 61 })))).toBe(
      'auth_date_in_future',
    );
    const tampered = hmacInitData(USER, { authDate: NOW }).replace(
      '%22id%22%3A42',
      '%22id%22%3A43',
    );
    expect(reason(() => verifier.verify(tampered))).toBe('hash_mismatch');
    expect(
      reason(() => verifier.verify(hmacInitData(USER, { authDate: NOW, token: '1:other' }))),
    ).toBe('hash_mismatch');
  });

  it('rejects structural problems', () => {
    expect(reason(() => verifier.verify('a=1&a=2'))).toBe('duplicate_key');
    expect(reason(() => verifier.verify('novalue'))).toBe('malformed');
    expect(reason(() => verifier.verify('a=1&&b=2'))).toBe('malformed');
    expect(reason(() => verifier.verify('auth_date=1'))).toBe('hash_missing');
    expect(
      reason(() => verifier.verify(hmacInitData({ id: 0, first_name: 'x' }, { authDate: NOW }))),
    ).toBe('user_id_invalid');
    expect(
      reason(() => verifier.verify(hmacInitData({ id: 5, first_name: ' ' }, { authDate: NOW }))),
    ).toBe('user_first_name_missing');
    expect(
      reason(() => verifier.verify(hmacInitData({ id: 5, first_name: 7 }, { authDate: NOW }))),
    ).toBe('user_field_type');
  });

  it('parses like parse_qsl(strict_parsing=True)', () => {
    expect([...parseInitData('a=b%20c+d&e=&=x&f=g=h&p=%ZZ')]).toEqual([
      ['a', 'b c d'],
      ['e', ''],
      ['', 'x'],
      ['f', 'g=h'],
      ['p', '%ZZ'],
    ]);
  });
});

describe('Ed25519 third-party validation', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  const botId = 123456789;
  const verifier = new Ed25519InitDataVerifier({
    botId,
    publicKeyHex: raw.toString('hex'),
    maxAgeSeconds: 3600,
    clock,
  });

  function signed(fields: Record<string, string>): string {
    const check = Object.keys(fields)
      .sort()
      .map((k) => `${k}=${fields[k]}`)
      .join('\n');
    const signature = sign(
      null,
      Buffer.from(`${botId}:WebAppData\n${check}`),
      createPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' })),
    );
    return new URLSearchParams({
      ...fields,
      signature: signature.toString('base64url'),
      hash: 'ignored',
    }).toString();
  }

  it('verifies the signature over everything but hash and signature', () => {
    const data = signed({
      auth_date: String(NOW),
      user: JSON.stringify({ id: 7, first_name: 'A' }),
    });
    expect(verifier.verify(data).telegramUserId).toBe(7);
  });

  it('rejects a mismatched or malformed signature', () => {
    const data = signed({
      auth_date: String(NOW),
      user: JSON.stringify({ id: 7, first_name: 'A' }),
    });
    expect(reason(() => verifier.verify(data.replace('auth_date=', 'auth_date=1')))).toBe(
      'signature_mismatch',
    );
    expect(reason(() => verifier.verify(`auth_date=${NOW}&signature=abc`))).toBe(
      'signature_malformed',
    );
    expect(reason(() => verifier.verify(`auth_date=${NOW}`))).toBe('signature_malformed');
  });
});
