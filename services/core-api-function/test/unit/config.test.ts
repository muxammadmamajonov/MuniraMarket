import { describe, expect, it } from 'vitest';
import { ConfigError, loadSettings } from '../../src/config.ts';
import { testEnv } from '../helpers/harness.ts';

// Fake, unroutable values; never real credentials or hosts.
const APP_URL =
  'postgresql://mm_app:fake-app-password-x7@ep-fake-1-pooler.eu-central-1.aws.neon.tech/mmdb?sslmode=require&channel_binding=require';
const OWNER_URL =
  'postgresql://neondb_owner:fake-owner-password-q9@ep-fake-1-pooler.eu-central-1.aws.neon.tech/mmdb?sslmode=require';

const production = (overrides: Record<string, string | undefined> = {}) =>
  testEnv({
    APP_ENV: 'production',
    MM_APP_DATABASE_URL: APP_URL,
    SESSION_COOKIE_SECURE: 'true',
    CSRF_TRUSTED_ORIGINS: 'https://muniramarket.uz,https://admin.muniramarket.uz',
    TELEGRAM_OIDC_ENABLED: 'true',
    TELEGRAM_OIDC_CLIENT_ID: '9038491407',
    TELEGRAM_OIDC_CLIENT_SECRET: 'test-only-oidc-secret',
    WEB_PUBLIC_ORIGIN: 'https://muniramarket.uz',
    ADMIN_PUBLIC_ORIGIN: 'https://admin.muniramarket.uz',
    ...overrides,
  });

function errorOf(env: Record<string, string | undefined>): string {
  try {
    loadSettings(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return String(error);
  }
  throw new Error('expected loadSettings to fail');
}

describe('loadSettings', () => {
  it('accepts a complete production configuration and uses only MM_APP_DATABASE_URL', () => {
    // Neon injects the owner URLs; the API must never pick them up.
    const settings = loadSettings(
      production({ DATABASE_URL: OWNER_URL, DATABASE_URL_UNPOOLED: OWNER_URL }),
    );
    expect(settings.databaseUrl).toBe(APP_URL);
    expect(settings.csrfTrustedOrigins).toEqual([
      'https://muniramarket.uz',
      'https://admin.muniramarket.uz',
    ]);
  });

  it('refuses to fall back to the injected DATABASE_URL', () => {
    expect(
      errorOf(production({ MM_APP_DATABASE_URL: undefined, DATABASE_URL: OWNER_URL })),
    ).toContain('MM_APP_DATABASE_URL is required');
  });

  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['not a URL', 'not a url at all'],
    ['wrong scheme', 'mysql://mm_app:pw@ep-x-pooler.example/db?sslmode=require'],
    ['no TLS', 'postgresql://mm_app:fake-pw@ep-x-pooler.eu-central-1.aws.neon.tech/mmdb'],
    [
      'sslmode=disable',
      'postgresql://mm_app:fake-pw@ep-x-pooler.eu-central-1.aws.neon.tech/mmdb?sslmode=disable',
    ],
    ['owner role', OWNER_URL],
    [
      'no password',
      'postgresql://mm_app@ep-x-pooler.eu-central-1.aws.neon.tech/mmdb?sslmode=require',
    ],
    [
      'direct endpoint',
      'postgresql://mm_app:fake-pw@ep-x.eu-central-1.aws.neon.tech/mmdb?sslmode=require',
    ],
    [
      'no database',
      'postgresql://mm_app:fake-pw@ep-x-pooler.eu-central-1.aws.neon.tech?sslmode=require',
    ],
  ])(
    'fails closed in production on a %s MM_APP_DATABASE_URL, without echoing it',
    (_label, url) => {
      const message = errorOf(production({ MM_APP_DATABASE_URL: url }));
      expect(message).toContain('MM_APP_DATABASE_URL');
      for (const fragment of [
        'fake-pw',
        'fake-owner-password',
        'neondb_owner',
        'ep-x',
        'mmdb',
        'aws.neon.tech',
      ]) {
        expect(message).not.toContain(fragment);
      }
    },
  );

  it('allows a plain local URL in development and test', () => {
    expect(
      loadSettings(testEnv({ MM_APP_DATABASE_URL: 'postgresql://dev@localhost:5432/mm' }))
        .databaseUrl,
    ).toBe('postgresql://dev@localhost:5432/mm');
  });

  it.each([
    [{ CORE_API_FUNCTION_SECRET: 'short' }, 'CORE_API_FUNCTION_SECRET'],
    [{ CORE_API_FUNCTION_SECRET: undefined }, 'CORE_API_FUNCTION_SECRET'],
    [{ SESSION_COOKIE_SECURE: 'false' }, 'SESSION_COOKIE_SECURE'],
    [{ CSRF_TRUSTED_ORIGINS: 'http://muniramarket.uz' }, 'CSRF_TRUSTED_ORIGINS'],
    [{ TELEGRAM_ENVIRONMENT: 'test' }, 'TELEGRAM_ENVIRONMENT'],
    [{ TELEGRAM_OIDC_ISSUER: 'https://evil.example' }, 'TELEGRAM_OIDC_ISSUER'],
    [{ SERVICE_AUTH_KEYS: 'scheduler:short' }, 'SERVICE_AUTH_KEYS'],
    [{ APP_ENV: undefined }, 'APP_ENV'],
  ])('fails closed on %j', (overrides, name) => {
    expect(errorOf(production(overrides))).toContain(name);
  });

  it('never echoes a secret value in an error', () => {
    expect(
      errorOf(production({ SERVICE_AUTH_KEYS: 'scheduler:not-long-enough-secret' })),
    ).not.toContain('not-long-enough-secret');
  });
});
