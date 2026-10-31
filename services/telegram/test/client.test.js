import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCoreApiClient } from '../tgcloud/lib/coreApi/client.js';
import { CoreApiError } from '../tgcloud/lib/coreApi/errors.js';
import { createFakeFetch } from './sdk-fake/fetch.js';
import { ADR_VECTOR, nodeSha256Hex } from './helpers.js';

const config = (baseUrl = 'https://core.example.test') => ({
  baseUrl,
  keyId: ADR_VECTOR.keyId,
  secret: ADR_VECTOR.secret,
});

const fixed = { now: () => ADR_VECTOR.timestamp * 1000, nonce: () => ADR_VECTOR.nonce };

/** Independently re-derives the signature from what was actually put on the wire. */
function verifyWire(call, secret = ADR_VECTOR.secret) {
  const { init } = call;
  const path = call.url.replace(/^https?:\/\/[^/]+/, '');
  const body = init.body ? Buffer.from(init.body) : Buffer.alloc(0);
  const h = init.headers;
  const canonical = [
    'MM-SVC-V1',
    h['X-MM-Key-Id'],
    h['X-MM-Timestamp'],
    h['X-MM-Nonce'],
    init.method,
    path,
    h['X-MM-Actor'],
    nodeSha256Hex(body),
  ].join('\n');
  return createHmac('sha256', secret).update(canonical).digest('hex') === h['X-MM-Signature'];
}

describe('createCoreApiClient', () => {
  it('signs exactly the bytes it sends (multibyte body) and sets JSON content type', async () => {
    const fetch = createFakeFetch(() => ({ body: '{"ok":true}' }));
    const client = createCoreApiClient({ fetch, config: config(), ...fixed });
    await client.request('POST', '/api/v1/internal/x?a=1', {
      actorTelegramUserId: 42,
      json: { name: 'Муниро ‘ 😀', n: 1 },
    });

    const [call] = fetch.calls;
    expect(call.url).toBe('https://core.example.test/api/v1/internal/x?a=1');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers['Content-Type']).toBe('application/json');
    expect(call.init.headers['X-MM-Actor']).toBe('tg:42');
    expect(call.init.body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(call.init.body)).toBe('{"name":"Муниро ‘ 😀","n":1}');
    expect(verifyWire(call)).toBe(true);
  });

  it('reproduces the ADR vector through the client', async () => {
    const fetch = createFakeFetch(() => ({ body: '{}' }));
    const client = createCoreApiClient({ fetch, config: config(), ...fixed });
    await client.request('POST', ADR_VECTOR.path, {
      actorTelegramUserId: 123456789,
      json: { telegram_user_id: 123456789 },
    });
    expect(fetch.calls[0].init.headers['X-MM-Signature']).toBe(ADR_VECTOR.signature);
  });

  it('signs the path that is actually requested, whatever trailing slashes the base had', async () => {
    for (const base of [
      'https://core.example.test',
      'https://core.example.test/',
      'HTTPS://Core.Example.Test:443/',
    ]) {
      const fetch = createFakeFetch();
      const client = createCoreApiClient({ fetch, config: config(base), ...fixed });
      await client.request('GET', '/api/v1/internal/telegram/me?x=1', { actorTelegramUserId: 7 });
      const [call] = fetch.calls;
      expect(call.url.startsWith('https://core.example.test')).toBe(true);
      expect(call.url).not.toMatch(/\/\/api/);
      expect(verifyWire(call)).toBe(true);
      expect(call.init.body).toBeUndefined();
      expect(call.init.headers['Content-Type']).toBeUndefined();
    }
  });

  it('refuses a base URL that carries a path and unsafe request paths', async () => {
    const fetch = createFakeFetch();
    expect(() =>
      createCoreApiClient({ fetch, config: config('https://core.example.test/prefix') }),
    ).toThrow(TypeError);
    const client = createCoreApiClient({ fetch, config: config(), ...fixed });
    for (const path of ['api/x', '//evil.example/x', '/a/../b', '/a/./b', '/a b', '/a#f', '/é']) {
      await expect(client.request('GET', path)).rejects.toThrow(TypeError);
    }
    await expect(client.request('GET', '/x', { actorTelegramUserId: -1 })).rejects.toThrow(
      TypeError,
    );
    await expect(client.request('GET', '/x', { actorTelegramUserId: 1.5 })).rejects.toThrow(
      TypeError,
    );
    expect(fetch.calls).toHaveLength(0);
  });

  it('parses JSON on success and returns null for an empty body', async () => {
    const fetch = createFakeFetch((url) =>
      url.endsWith('/empty') ? { status: 204, body: '' } : { body: '{"user":{"id":1}}' },
    );
    const client = createCoreApiClient({ fetch, config: config(), ...fixed });
    await expect(client.request('GET', '/json')).resolves.toEqual({ user: { id: 1 } });
    await expect(client.request('GET', '/empty')).resolves.toBeNull();
  });

  it.each([
    [401, 'UNAUTHORIZED'],
    [403, 'UNAUTHORIZED'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [422, 'BAD_REQUEST'],
    [429, 'RATE_LIMITED'],
    [500, 'UPSTREAM_ERROR'],
    [503, 'UPSTREAM_ERROR'],
  ])('maps HTTP %i to CoreApiError %s without leaking the response body', async (status, code) => {
    const secretBody = 'internal stack trace secret-detail';
    const fetch = createFakeFetch(() => ({ status, body: secretBody }));
    const client = createCoreApiClient({ fetch, config: config(), ...fixed });
    const error = await client.request('GET', '/x').catch((e) => e);
    expect(error).toBeInstanceOf(CoreApiError);
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
    expect(String(error.message)).not.toContain('secret-detail');
    expect(JSON.stringify(error)).not.toContain('secret-detail');
  });

  it('maps network failures and invalid JSON, never echoing the underlying error', async () => {
    const down = createCoreApiClient({
      fetch: async () => {
        throw new Error('connect ECONNREFUSED with-secret-detail');
      },
      config: config(),
      ...fixed,
    });
    const networkError = await down.request('GET', '/x').catch((e) => e);
    expect(networkError).toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    expect(networkError.message).not.toContain('with-secret-detail');

    const bad = createCoreApiClient({
      fetch: createFakeFetch(() => ({ body: '<html>oops' })),
      config: config(),
      ...fixed,
    });
    await expect(bad.request('GET', '/x')).rejects.toMatchObject({
      status: 200,
      code: 'INVALID_RESPONSE',
    });
  });

  it('times out via AbortSignal when the runtime provides AbortController', async () => {
    const hanging = (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const client = createCoreApiClient({
      fetch: hanging,
      config: config(),
      ...fixed,
      timeoutMs: 20,
    });
    await expect(client.request('GET', '/x')).rejects.toMatchObject({ status: 0, code: 'TIMEOUT' });
  });

  it('does not attach a signal when timeouts are disabled or unsupported', async () => {
    const fetch = createFakeFetch();
    const client = createCoreApiClient({ fetch, config: config(), ...fixed, timeoutMs: 0 });
    await client.request('GET', '/x');
    expect(fetch.calls[0].init.signal).toBeUndefined();
  });

  it('syncTelegramUser posts the documented body with tg:<id> as actor', async () => {
    const fetch = createFakeFetch(() => ({ body: '{"user":{"telegram_user_id":99}}' }));
    const client = createCoreApiClient({ fetch, config: config(), ...fixed });
    const result = await client.syncTelegramUser({
      id: 99,
      first_name: 'Ann',
      username: 'ann',
      language_code: 'ru',
    });
    expect(result).toEqual({ user: { telegram_user_id: 99 } });
    const [call] = fetch.calls;
    expect(call.url).toBe('https://core.example.test/api/v1/internal/telegram/session');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers['X-MM-Actor']).toBe('tg:99');
    expect(JSON.parse(new TextDecoder().decode(call.init.body))).toEqual({
      telegram_user_id: 99,
      first_name: 'Ann',
      last_name: null,
      username: 'ann',
      language_code: 'ru',
    });
    expect(verifyWire(call)).toBe(true);
  });

  it('getMe issues a signed GET with the actor', async () => {
    const fetch = createFakeFetch(() => ({ body: '{"user":null}' }));
    const client = createCoreApiClient({ fetch, config: config(), ...fixed });
    await client.getMe(5);
    const [call] = fetch.calls;
    expect(call.url).toBe('https://core.example.test/api/v1/internal/telegram/me');
    expect(call.init.method).toBe('GET');
    expect(call.init.headers['X-MM-Actor']).toBe('tg:5');
    expect(verifyWire(call)).toBe(true);
  });

  it('never sends the secret', async () => {
    const fetch = createFakeFetch();
    const client = createCoreApiClient({ fetch, config: config(), ...fixed });
    await client.syncTelegramUser({ id: 1, first_name: 'A' });
    const wire = JSON.stringify(fetch.calls[0].init.headers) + fetch.calls[0].url;
    expect(wire).not.toContain(ADR_VECTOR.secret);
  });
});

describe('notification outbox calls', () => {
  const ID = '0b6f3f6e-6a8c-4a47-9d0e-3b1f2c4d5e6f';

  it('claimNotifications posts {limit} signed with an EMPTY actor', async () => {
    const fetch = createFakeFetch(() => ({
      body: '{"items":[],"lease_expires_at":"2026-10-31T10:00:00Z"}',
    }));
    const client = createCoreApiClient({ fetch, config: config(), ...fixed });
    await expect(client.claimNotifications({ limit: 20 })).resolves.toEqual({
      items: [],
      lease_expires_at: '2026-10-31T10:00:00Z',
    });
    const [call] = fetch.calls;
    expect(call.url).toBe('https://core.example.test/api/v1/internal/telegram/notifications/claim');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers['X-MM-Actor']).toBe('');
    expect(call.init.headers['Content-Type']).toBe('application/json');
    expect(call.init.headers['X-MM-Key-Id']).toBe(ADR_VECTOR.keyId);
    expect(call.init.headers['X-MM-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(new TextDecoder().decode(call.init.body)).toBe('{"limit":20}');
    expect(verifyWire(call)).toBe(true);
  });

  it.each([0, 51, 1.5, -1, '5', undefined, NaN])(
    'claimNotifications rejects limit %j',
    async (limit) => {
      const fetch = createFakeFetch();
      const client = createCoreApiClient({ fetch, config: config(), ...fixed });
      await expect(client.claimNotifications({ limit })).rejects.toThrow(TypeError);
      expect(fetch.calls).toHaveLength(0);
    },
  );

  it('reportNotification posts the outcome (and error_code) to /{id}/result and returns null on 204', async () => {
    const fetch = createFakeFetch(() => ({ status: 204, body: '' }));
    const client = createCoreApiClient({ fetch, config: config(), ...fixed });
    await expect(
      client.reportNotification(ID, { attempt: 2, outcome: 'retry', errorCode: 'bot_api_429' }),
    ).resolves.toBeNull();
    await client.reportNotification(ID, { attempt: 1, outcome: 'delivered' });

    const [withCode, without] = fetch.calls;
    expect(withCode.url).toBe(
      `https://core.example.test/api/v1/internal/telegram/notifications/${ID}/result`,
    );
    expect(withCode.init.method).toBe('POST');
    expect(withCode.init.headers['X-MM-Actor']).toBe('');
    expect(JSON.parse(new TextDecoder().decode(withCode.init.body))).toEqual({
      attempt: 2,
      outcome: 'retry',
      error_code: 'bot_api_429',
    });
    expect(verifyWire(withCode)).toBe(true);
    expect(new TextDecoder().decode(without.init.body)).toBe('{"attempt":1,"outcome":"delivered"}');
    expect(verifyWire(without)).toBe(true);
  });

  it('reportNotification validates id, outcome and error code before any request', async () => {
    const fetch = createFakeFetch();
    const client = createCoreApiClient({ fetch, config: config(), ...fixed });
    for (const id of ['', 'x', `${ID}/../claim`, `${ID}?a=1`, `../${ID}`, 42, undefined]) {
      await expect(
        client.reportNotification(id, { attempt: 1, outcome: 'delivered' }),
      ).rejects.toThrow(TypeError);
    }
    await expect(client.reportNotification(ID, { attempt: 1, outcome: 'sent' })).rejects.toThrow(
      TypeError,
    );
    for (const attempt of [undefined, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        // @ts-expect-error deliberately invalid attempts
        client.reportNotification(ID, { attempt, outcome: 'delivered' }),
      ).rejects.toThrow(TypeError);
    }
    for (const errorCode of ['', 'Bad Code', 'UPPER', 'a'.repeat(65), 'with space', 5]) {
      await expect(
        client.reportNotification(ID, { attempt: 1, outcome: 'failed', errorCode }),
      ).rejects.toThrow(TypeError);
    }
    expect(fetch.calls).toHaveLength(0);
  });

  it.each([
    [401, 'UNAUTHORIZED'],
    [403, 'UNAUTHORIZED'],
    [404, 'NOT_FOUND'],
    [500, 'UPSTREAM_ERROR'],
  ])('maps HTTP %i on report/claim to CoreApiError %s', async (status, code) => {
    const fetch = createFakeFetch(() => ({ status, body: '{"detail":"secret-detail"}' }));
    const client = createCoreApiClient({ fetch, config: config(), ...fixed });
    for (const call of [
      () => client.claimNotifications({ limit: 1 }),
      () => client.reportNotification(ID, { attempt: 1, outcome: 'delivered' }),
    ]) {
      const error = await call().catch((e) => e);
      expect(error).toBeInstanceOf(CoreApiError);
      expect(error).toMatchObject({ status, code });
      expect(error.message).not.toContain('secret-detail');
    }
  });
});
