/**
 * Validation of the deploy-time (non-secret) variables: the hostnames the Cloudflare
 * configurations read (`MM_*_HOSTNAME`) and the values the Core API Neon Function receives
 * through neon.ts (`MM_TELEGRAM_BOT_ID` -> TELEGRAM_BOT_ID, `MM_CSRF_TRUSTED_ORIGINS` ->
 * CSRF_TRUSTED_ORIGINS, `APP_RELEASE`). Run before every deploy:
 *
 *   node infra/cloudflare/scripts/validate-deploy-env.mts --mode staging
 *
 * Secrets are not checked here (Worker secrets: `cf deploy` refuses to deploy while a declared
 * `bindings.secret()` is missing; Function secrets: `neon deploy` refuses a missing env value).
 * This catches the configuration that would otherwise only fail at runtime: the Core API refuses
 * to start without these values (fail closed), which would surface as 503s after the deploy.
 * There is no container image any more (no Containers on the Workers Free plan).
 */

import { isIP } from 'node:net';
import type { DeployedEnvironment } from './environments.mts';

export interface DeployEnvProblem {
  variable: string;
  message: string;
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// Production is pinned to the hostnames whose OIDC redirect URIs are registered with BotFather
// (`https://<host>/api/v1/auth/telegram/oidc/callback`, ADR 0014) and to the one bot whose id is
// the OIDC client id. `munira-market.uz` is deliberately not canonical (a later redirect, if ever).
export const PRODUCTION_WEB_HOSTNAME = 'muniramarket.uz';
export const PRODUCTION_ADMIN_HOSTNAME = 'admin.muniramarket.uz';
export const PRODUCTION_TELEGRAM_BOT_ID = '9038491407';
const RELEASE = /^[A-Za-z0-9._-]{1,64}$/;
const TEST_TLDS = ['.test', '.example', '.invalid', '.localhost', '.local', '.internal'];

function hostnameProblem(value: string, allowTestTld: boolean): string | null {
  if (!HOSTNAME.test(value)) return 'must be a lower-case DNS hostname (no scheme, port or path)';
  if (isIP(value) !== 0) return 'must not be an IP address';
  if (!allowTestTld && TEST_TLDS.some((tld) => value.endsWith(tld))) {
    return 'must be a real public hostname in production';
  }
  return null;
}

export function validateDeployEnv(
  mode: DeployedEnvironment,
  env: Readonly<Record<string, string | undefined>>,
): DeployEnvProblem[] {
  const problems: DeployEnvProblem[] = [];
  const value = (name: string) => env[name]?.trim() ?? '';
  const require = (name: string) => {
    if (value(name) === '') problems.push({ variable: name, message: 'is required' });
    return value(name);
  };
  const allowTestTld = mode !== 'production';

  const hosts: Record<string, string> = {};
  for (const name of ['MM_WEB_HOSTNAME', 'MM_ADMIN_HOSTNAME', 'MM_API_HOSTNAME']) {
    const host = require(name);
    if (host === '') continue;
    const problem = hostnameProblem(host, allowTestTld);
    if (problem) problems.push({ variable: name, message: problem });
    hosts[name] = host;
  }
  const distinct = new Set(Object.values(hosts));
  if (distinct.size !== Object.keys(hosts).length) {
    problems.push({
      variable: 'MM_*_HOSTNAME',
      message: 'web, admin and API hostnames must all be different (separate origins)',
    });
  }

  const botId = require('MM_TELEGRAM_BOT_ID');
  if (botId !== '' && !/^[1-9]\d{4,14}$/.test(botId)) {
    problems.push({ variable: 'MM_TELEGRAM_BOT_ID', message: 'must be the numeric bot id' });
  }
  if (mode === 'production') {
    // One bot for everything: the Mini App, the bot itself and OIDC browser sign-in.
    if (botId !== '' && botId !== PRODUCTION_TELEGRAM_BOT_ID) {
      problems.push({
        variable: 'MM_TELEGRAM_BOT_ID',
        message: `must be the production bot (OIDC client id ${PRODUCTION_TELEGRAM_BOT_ID})`,
      });
    }
    const pinned: Array<[string, string]> = [
      ['MM_WEB_HOSTNAME', PRODUCTION_WEB_HOSTNAME],
      ['MM_ADMIN_HOSTNAME', PRODUCTION_ADMIN_HOSTNAME],
    ];
    for (const [name, expected] of pinned) {
      if (hosts[name] && hosts[name] !== expected) {
        problems.push({
          variable: name,
          message: `must be ${expected} (its OIDC redirect URI is registered with BotFather)`,
        });
      }
    }
  }

  // The Core API must trust exactly the storefront and admin origins (CSRF Origin check).
  const origins = require('MM_CSRF_TRUSTED_ORIGINS');
  if (origins !== '' && hosts['MM_WEB_HOSTNAME'] && hosts['MM_ADMIN_HOSTNAME']) {
    const actual = new Set(
      origins
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    );
    const expected = new Set([
      `https://${hosts['MM_WEB_HOSTNAME']}`,
      `https://${hosts['MM_ADMIN_HOSTNAME']}`,
    ]);
    const same = actual.size === expected.size && [...expected].every((o) => actual.has(o));
    if (!same) {
      problems.push({
        variable: 'MM_CSRF_TRUSTED_ORIGINS',
        message: 'must be exactly https://<MM_WEB_HOSTNAME>,https://<MM_ADMIN_HOSTNAME>',
      });
    }
  }

  const release = value('APP_RELEASE');
  if (release !== '' && !RELEASE.test(release)) {
    problems.push({ variable: 'APP_RELEASE', message: 'must be 1-64 of [A-Za-z0-9._-]' });
  }
  // Every production log line carries the release (Function env APP_RELEASE).
  if (mode === 'production' && release === '') {
    problems.push({ variable: 'APP_RELEASE', message: 'is required' });
  }

  return problems;
}
