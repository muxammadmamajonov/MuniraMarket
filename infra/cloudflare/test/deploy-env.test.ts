import { describe, expect, it } from 'vitest';
import { validateDeployEnv } from '../deploy-env.mts';
import { deploymentTarget } from '../environments.mts';

// Fixture values only (reserved .test TLD, fake ids); never real hostnames.
const staging = {
  MM_WEB_HOSTNAME: 'shop.staging.example.test',
  MM_ADMIN_HOSTNAME: 'admin.staging.example.test',
  MM_API_HOSTNAME: 'api.staging.example.test',
  MM_TELEGRAM_BOT_ID: '1234567890',
  MM_CSRF_TRUSTED_ORIGINS: 'https://shop.staging.example.test,https://admin.staging.example.test',
};
const DIGEST = `registry.cloudflare.com/fake-account/muniramarket-core-api@sha256:${'a'.repeat(64)}`;

const variables = (env: Record<string, string | undefined>, mode: 'staging' | 'production') =>
  validateDeployEnv(mode, env).map((p) => p.variable);

describe('validateDeployEnv', () => {
  it('accepts a complete staging environment', () => {
    expect(validateDeployEnv('staging', staging)).toEqual([]);
  });

  it('requires every variable', () => {
    expect(variables({}, 'staging')).toEqual([
      'MM_WEB_HOSTNAME',
      'MM_ADMIN_HOSTNAME',
      'MM_API_HOSTNAME',
      'MM_TELEGRAM_BOT_ID',
      'MM_CSRF_TRUSTED_ORIGINS',
    ]);
  });

  it('rejects malformed hostnames and shared origins', () => {
    expect(
      variables({ ...staging, MM_WEB_HOSTNAME: 'https://shop.example.test' }, 'staging'),
    ).toContain('MM_WEB_HOSTNAME');
    expect(variables({ ...staging, MM_API_HOSTNAME: '203.0.113.7' }, 'staging')).toContain(
      'MM_API_HOSTNAME',
    );
    expect(
      variables({ ...staging, MM_ADMIN_HOSTNAME: staging.MM_WEB_HOSTNAME }, 'staging'),
    ).toContain('MM_*_HOSTNAME');
  });

  it('requires CSRF origins to match the web and admin hostnames exactly', () => {
    expect(
      variables(
        { ...staging, MM_CSRF_TRUSTED_ORIGINS: 'https://shop.staging.example.test' },
        'staging',
      ),
    ).toEqual(['MM_CSRF_TRUSTED_ORIGINS']);
    expect(
      variables(
        {
          ...staging,
          MM_CSRF_TRUSTED_ORIGINS: `${staging.MM_CSRF_TRUSTED_ORIGINS},https://evil.test`,
        },
        'staging',
      ),
    ).toEqual(['MM_CSRF_TRUSTED_ORIGINS']);
  });

  it('requires a digest-pinned image and a release in production, and real hostnames', () => {
    const problems = variables(staging, 'production');
    expect(problems).toContain('CORE_API_IMAGE');
    expect(problems).toContain('APP_RELEASE');
    expect(problems).toContain('MM_WEB_HOSTNAME');
    expect(
      variables(
        { ...staging, CORE_API_IMAGE: 'registry.cloudflare.com/fake-account/api:latest' },
        'staging',
      ),
    ).toEqual(['CORE_API_IMAGE']);
    expect(
      variables({ ...staging, CORE_API_IMAGE: DIGEST, APP_RELEASE: 'sha-0123abc' }, 'staging'),
    ).toEqual([]);
  });

  it('pins production to the registered OIDC hostnames and the single bot', () => {
    // The real production values are public facts (domains, bot id), not secrets.
    const production = {
      MM_WEB_HOSTNAME: 'muniramarket.uz',
      MM_ADMIN_HOSTNAME: 'admin.muniramarket.uz',
      MM_API_HOSTNAME: 'api.muniramarket.uz',
      MM_TELEGRAM_BOT_ID: '9038491407',
      MM_CSRF_TRUSTED_ORIGINS: 'https://muniramarket.uz,https://admin.muniramarket.uz',
      CORE_API_IMAGE: DIGEST,
      APP_RELEASE: 'sha-0123abc',
    };
    expect(validateDeployEnv('production', production)).toEqual([]);
    expect(variables({ ...production, MM_TELEGRAM_BOT_ID: '1234567890' }, 'production')).toEqual([
      'MM_TELEGRAM_BOT_ID',
    ]);
    expect(
      variables(
        {
          ...production,
          MM_WEB_HOSTNAME: 'munira-market.uz',
          MM_CSRF_TRUSTED_ORIGINS: 'https://munira-market.uz,https://admin.muniramarket.uz',
        },
        'production',
      ),
    ).toEqual(['MM_WEB_HOSTNAME']);
  });
});

describe('deploymentTarget', () => {
  it('maps modes to names and APP_ENV', () => {
    expect(deploymentTarget('production')).toMatchObject({ suffix: '', appEnv: 'production' });
    expect(deploymentTarget('staging')).toMatchObject({ suffix: '-staging', appEnv: 'staging' });
    // Previews and anything unknown are never production.
    expect(deploymentTarget(undefined)).toMatchObject({ deployed: false, production: false });
    expect(deploymentTarget('preview')).toMatchObject({ deployed: false, production: false });
  });
});
