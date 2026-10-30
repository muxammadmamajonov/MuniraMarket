import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EndpointError } from 'sdk';
import { db as sdkDb, fetch as sdkFetch } from 'sdk';
import getProfileEndpoint from '../tgcloud/endpoints/getProfile.js';
import { getProfile, getProfileWithConfig } from '../tgcloud/lib/miniapp/profile.js';
import { ADR_VECTOR, TEST_CONFIG_ROWS, rowsFrom, silentLogger } from './helpers.js';

const verifiedCtx = (
  user = { id: 777, first_name: 'Ann', username: 'ann', language_code: 'uz' },
) => ({
  initData: { user, auth_date: 1, hash: 'x' },
});

let log;
beforeEach(() => {
  log = silentLogger();
});

async function expectUnavailable(promise) {
  const error = await promise.catch((e) => e);
  expect(error).toBeInstanceOf(EndpointError);
  expect(error.message).toBe('Profile is temporarily unavailable');
  expect(error.parameters).toEqual({ code: 'PROFILE_UNAVAILABLE' });
  return error;
}

describe('getProfile (logic)', () => {
  it('syncs the verified ctx user and returns { user } from Core', async () => {
    const coreApi = {
      syncTelegramUser: vi.fn(async () => ({ user: { id: 'u1', telegram_user_id: 777 } })),
    };
    const result = await getProfile({}, verifiedCtx(), { coreApi, log });
    expect(result).toEqual({ user: { id: 'u1', telegram_user_id: 777 } });
    expect(coreApi.syncTelegramUser).toHaveBeenCalledWith({
      id: 777,
      first_name: 'Ann',
      username: 'ann',
      language_code: 'uz',
    });
  });

  it('never takes identity from input', async () => {
    const coreApi = { syncTelegramUser: vi.fn(async () => ({ user: {} })) };
    await getProfile(
      {
        telegram_user_id: 1,
        user: { id: 1, first_name: 'Mallory' },
        initData: { user: { id: 2, first_name: 'X' } },
      },
      verifiedCtx(),
      { coreApi, log },
    );
    expect(coreApi.syncTelegramUser.mock.calls[0][0].id).toBe(777);
  });

  it('refuses when verified init data has no usable user, without calling Core', async () => {
    const coreApi = { syncTelegramUser: vi.fn() };
    for (const ctx of [
      undefined,
      {},
      { initData: {} },
      { initData: { user: null } },
      verifiedCtx({ id: 'abc', first_name: 'x' }),
      verifiedCtx({ id: -5, first_name: 'x' }),
    ]) {
      await expectUnavailable(getProfile({ telegram_user_id: 777 }, ctx, { coreApi, log }));
    }
    expect(coreApi.syncTelegramUser).not.toHaveBeenCalled();
  });

  it('maps Core API failures and malformed responses to PROFILE_UNAVAILABLE with no internals', async () => {
    const failing = {
      syncTelegramUser: async () => {
        throw Object.assign(
          new Error('Core API request failed (status 500, code UPSTREAM_ERROR)'),
          {
            name: 'CoreApiError',
            status: 500,
            code: 'UPSTREAM_ERROR',
          },
        );
      },
    };
    const error = await expectUnavailable(getProfile({}, verifiedCtx(), { coreApi: failing, log }));
    expect(error.message).not.toMatch(/500|UPSTREAM|Core/);

    for (const response of [null, 'x', {}, undefined]) {
      await expectUnavailable(
        getProfile({}, verifiedCtx(), { coreApi: { syncTelegramUser: async () => response }, log }),
      );
    }
  });
});

describe('getProfile (config wiring)', () => {
  const makeDb = (rows) => ({
    select: () => ({ from: () => ({ all: async () => rows }) }),
  });

  it('fails closed with PROFILE_UNAVAILABLE when service config is missing', async () => {
    const fetch = vi.fn();
    await expectUnavailable(
      getProfileWithConfig({}, verifiedCtx(), { db: makeDb([]), fetch, log }),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(log.entries.map((e) => e.text).join('\n')).not.toContain(ADR_VECTOR.secret);
  });
});

describe('endpoints/getProfile.js (through the sdk double)', () => {
  it('uses ctx.initData.user and ignores identity claims in input', async () => {
    sdkDb.__setRows('service_config', rowsFrom(TEST_CONFIG_ROWS));
    sdkFetch.__setHandler(() => ({ body: '{"user":{"telegram_user_id":777,"first_name":"Ann"}}' }));
    sdkFetch.calls.length = 0;

    const result = await getProfileEndpoint(
      { telegram_user_id: 1, user: { id: 1 }, actor: 'tg:1' },
      verifiedCtx(),
    );

    expect(result).toEqual({ user: { telegram_user_id: 777, first_name: 'Ann' } });
    expect(sdkFetch.calls).toHaveLength(1);
    const [{ url, init }] = sdkFetch.calls;
    expect(url).toBe('https://core.example.test/api/v1/internal/telegram/session');
    expect(init.headers['X-MM-Actor']).toBe('tg:777');
    expect(JSON.parse(new TextDecoder().decode(init.body)).telegram_user_id).toBe(777);
  });

  it('throws EndpointError PROFILE_UNAVAILABLE when Core API rejects', async () => {
    sdkDb.__setRows('service_config', rowsFrom(TEST_CONFIG_ROWS));
    sdkFetch.__setHandler(() => ({ status: 401, body: 'nope' }));
    await expectUnavailable(getProfileEndpoint({}, verifiedCtx()));
  });
});
