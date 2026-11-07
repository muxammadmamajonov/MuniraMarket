import { describe, expect, it } from 'vitest';
import { ConfigError, loadSettings } from '../../src/config.ts';
import { testEnv } from '../helpers/harness.ts';

const production = (overrides: Record<string, string | undefined> = {}) =>
  testEnv({
    APP_ENV: 'production',
    DATABASE_URL: 'postgresql://role:pw@ep-x-pooler.eu-central-1.aws.neon.tech/db?sslmode=require',
    SESSION_COOKIE_SECURE: 'true',
    CSRF_TRUSTED_ORIGINS: 'https://muniramarket.uz,https://admin.muniramarket.uz',
    TELEGRAM_OIDC_ENABLED: 'true',
    TELEGRAM_OIDC_CLIENT_ID: '9038491407',
    TELEGRAM_OIDC_CLIENT_SECRET: 'test-only-oidc-secret',
    WEB_PUBLIC_ORIGIN: 'https://muniramarket.uz',
    ADMIN_PUBLIC_ORIGIN: 'https://admin.muniramarket.uz',
    DB_RUNTIME_ROLE: 'mm_app',
    ...overrides,
  });

describe('loadSettings', () => {
  it('accepts a complete production configuration', () => {
    const settings = loadSettings(production());
    expect(settings.dbRuntimeRole).toBe('mm_app');
    expect(settings.csrfTrustedOrigins).toEqual([
      'https://muniramarket.uz',
      'https://admin.muniramarket.uz',
    ]);
  });

  it.each([
    [{ DB_RUNTIME_ROLE: undefined }, 'DB_RUNTIME_ROLE'],
    [{ DB_RUNTIME_ROLE: 'mm_app; drop table x' }, 'DB_RUNTIME_ROLE'],
    [{ CORE_API_FUNCTION_SECRET: 'short' }, 'CORE_API_FUNCTION_SECRET'],
    [{ CORE_API_FUNCTION_SECRET: undefined }, 'CORE_API_FUNCTION_SECRET'],
    [{ DATABASE_URL: 'postgresql://r:p@h/db' }, 'TLS'],
    [{ SESSION_COOKIE_SECURE: 'false' }, 'SESSION_COOKIE_SECURE'],
    [{ CSRF_TRUSTED_ORIGINS: 'http://muniramarket.uz' }, 'CSRF_TRUSTED_ORIGINS'],
    [{ TELEGRAM_ENVIRONMENT: 'test' }, 'TELEGRAM_ENVIRONMENT'],
    [{ TELEGRAM_OIDC_ISSUER: 'https://evil.example' }, 'TELEGRAM_OIDC_ISSUER'],
    [{ SERVICE_AUTH_KEYS: 'scheduler:short' }, 'SERVICE_AUTH_KEYS'],
    [{ APP_ENV: undefined }, 'APP_ENV'],
  ])('fails closed on %j', (overrides, name) => {
    expect(() => loadSettings(production(overrides))).toThrow(ConfigError);
    expect(() => loadSettings(production(overrides))).toThrow(name);
  });

  it('never echoes a secret value in an error', () => {
    const secret = 'scheduler:not-long-enough-secret';
    try {
      loadSettings(production({ SERVICE_AUTH_KEYS: secret }));
    } catch (error) {
      expect(String(error)).not.toContain('not-long-enough-secret');
    }
  });
});
