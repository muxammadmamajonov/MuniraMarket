import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadServiceConfig,
  parseBotConfig,
  parseServiceConfig,
  readConfigRows,
} from '../tgcloud/lib/config.js';
import { createFakeDb } from './sdk-fake/db.js';
import { ADR_VECTOR, TEST_CONFIG_ROWS, rowsFrom } from './helpers.js';

const dbWith = (record) => {
  const db = createFakeDb();
  db.__setRows('service_config', rowsFrom(record));
  return db;
};

describe('loadServiceConfig (fail closed)', () => {
  it('loads and normalises a valid config from an injected db', async () => {
    const config = await loadServiceConfig(
      dbWith({ ...TEST_CONFIG_ROWS, core_api_base_url: 'https://Core.Example.test/' }),
    );
    expect(config).toEqual({
      baseUrl: 'https://core.example.test',
      keyId: 'test-key',
      secret: ADR_VECTOR.secret,
    });
  });

  it('keeps an explicit port and allows http only for localhost', async () => {
    const withUrl = (core_api_base_url) =>
      loadServiceConfig(dbWith({ ...TEST_CONFIG_ROWS, core_api_base_url }));
    await expect(withUrl('https://core.example.test:8443')).resolves.toMatchObject({
      baseUrl: 'https://core.example.test:8443',
    });
    await expect(withUrl('http://localhost:8000')).resolves.toMatchObject({
      baseUrl: 'http://localhost:8000',
    });
    await expect(withUrl('http://127.0.0.1:8000')).resolves.toBeTruthy();
    await expect(withUrl('http://[::1]:8000')).resolves.toBeTruthy();
    for (const bad of [
      'http://core.example.test',
      'http://localhost.evil.test',
      'ftp://core.example.test',
      'core.example.test',
      'https://user:pw@core.example.test',
      'https://core.example.test/api',
      'https://core.example.test?x=1',
      'https://core.example.test#f',
      'https://',
      '',
    ]) {
      await expect(withUrl(bad)).rejects.toBeInstanceOf(ConfigError);
    }
  });

  it.each(['core_api_base_url', 'service_key_id', 'service_secret'])(
    'fails when %s is missing',
    async (key) => {
      const rows = { ...TEST_CONFIG_ROWS };
      delete rows[key];
      await expect(loadServiceConfig(dbWith(rows))).rejects.toMatchObject({
        name: 'ConfigError',
        key,
      });
    },
  );

  it('fails on an empty table', async () => {
    await expect(loadServiceConfig(dbWith({}))).rejects.toBeInstanceOf(ConfigError);
  });

  it('rejects a bad key id and a secret shorter than 32 bytes without echoing values', async () => {
    const weak = 'x'.repeat(31);
    const error = await loadServiceConfig(
      dbWith({ ...TEST_CONFIG_ROWS, service_secret: weak }),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).not.toContain(weak);
    expect(error.message).toContain('service_secret');

    await expect(
      loadServiceConfig(dbWith({ ...TEST_CONFIG_ROWS, service_secret: 'x'.repeat(32) })),
    ).resolves.toBeTruthy();
    await expect(
      loadServiceConfig(dbWith({ ...TEST_CONFIG_ROWS, service_key_id: 'bad key!' })),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('never includes the secret in any ConfigError message', async () => {
    for (const patch of [
      { core_api_base_url: 'http://core.example.test' },
      { service_key_id: '!' },
      { service_secret: ADR_VECTOR.secret.slice(0, 10) },
    ]) {
      const error = await loadServiceConfig(dbWith({ ...TEST_CONFIG_ROWS, ...patch })).catch(
        (e) => e,
      );
      expect(error.message).not.toContain(ADR_VECTOR.secret);
      expect(error.message).not.toContain(ADR_VECTOR.secret.slice(0, 10));
    }
  });

  it('propagates database failures (fail closed)', async () => {
    const db = createFakeDb();
    db.__failWith(new Error('db down'));
    await expect(loadServiceConfig(db)).rejects.toThrow('db down');
  });

  it('readConfigRows ignores malformed rows', async () => {
    const db = createFakeDb();
    db.__setRows('service_config', [
      { key: 'a', value: '1' },
      { key: 'b', value: null },
      { key: 3, value: 'x' },
    ]);
    expect(await readConfigRows(db)).toEqual({ a: '1' });
  });
});

describe('parseBotConfig', () => {
  it('accepts an https mini app URL and a valid username', () => {
    expect(
      parseBotConfig({ mini_app_url: 'https://app.example.test/', bot_username: '@some_bot' }),
    ).toEqual({
      miniAppUrl: 'https://app.example.test/',
      botUsername: 'some_bot',
      warnings: [],
    });
  });

  it('treats invalid optional values as absent with a warning', () => {
    const parsed = parseBotConfig({ mini_app_url: 'http://app.example.test', bot_username: 'a b' });
    expect(parsed.miniAppUrl).toBeNull();
    expect(parsed.botUsername).toBeNull();
    expect(parsed.warnings).toHaveLength(2);
    expect(parseBotConfig({}).warnings).toEqual([]);
  });

  it('parseServiceConfig is reusable on pre-read rows', () => {
    expect(parseServiceConfig(TEST_CONFIG_ROWS).keyId).toBe('test-key');
  });
});
