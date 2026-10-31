/**
 * Validation of the deploy-time (non-secret) variables the Cloudflare configurations read
 * (`MM_*`, `CORE_API_IMAGE`, `APP_RELEASE`). Run before every deploy:
 *
 *   node infra/cloudflare/scripts/validate-deploy-env.mts --mode staging
 *
 * Secrets are not checked here (they live on the Workers; `cf deploy` refuses to deploy while a
 * declared `bindings.secret()` is missing). This catches the configuration that would otherwise
 * only fail at runtime: the Core API refuses to start without these values (fail closed), which
 * would surface as 503s after the deploy.
 */

import { isIP } from 'node:net';
import type { DeployedEnvironment } from './environments.mts';

export interface DeployEnvProblem {
  variable: string;
  message: string;
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const BOT_USERNAME = /^[A-Za-z0-9_]{5,32}$/;
const RELEASE = /^[A-Za-z0-9._-]{1,64}$/;
// Durable Object-scheduled Containers only start digest-pinned images from Cloudflare's registry.
const DIGEST_REF = /^registry\.cloudflare\.com\/[A-Za-z0-9_-]+\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;
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
  const botUsername = require('MM_TELEGRAM_BOT_USERNAME');
  if (botUsername !== '' && !BOT_USERNAME.test(botUsername.replace(/^@/, ''))) {
    problems.push({ variable: 'MM_TELEGRAM_BOT_USERNAME', message: 'is not a bot username' });
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

  const image = value('CORE_API_IMAGE');
  if (mode === 'production') {
    if (image === '') {
      problems.push({
        variable: 'CORE_API_IMAGE',
        message: 'production deploys an immutable image reference, never a local Dockerfile build',
      });
    }
    if (release === '') problems.push({ variable: 'APP_RELEASE', message: 'is required' });
  }
  if (image !== '' && !DIGEST_REF.test(image)) {
    problems.push({
      variable: 'CORE_API_IMAGE',
      message: 'must be registry.cloudflare.com/<account>/<repository>@sha256:<64 hex>',
    });
  }
  return problems;
}
