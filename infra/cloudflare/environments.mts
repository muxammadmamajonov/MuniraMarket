/**
 * Deployment environments shared by every Cloudflare configuration (`cloudflare.config.ts` of
 * the web app, the admin app and the Core API gateway).
 *
 * `--mode staging` and `--mode production` select a deployed environment; any other mode
 * (`development`, `undefined`, Vite's defaults) is local development. Each deployed environment
 * is a separate set of Workers (name suffix), with its own secrets, Neon database, Redis and R2
 * bucket. A Preview build never targets production resources.
 */

export type DeployedEnvironment = 'staging' | 'production';

export interface DeploymentTarget {
  /** `-staging`, `''` for production, `-dev` locally. Appended to every Worker/app name. */
  suffix: string;
  /** Value of the Core API's `APP_ENV`. */
  appEnv: DeployedEnvironment | 'development';
  deployed: boolean;
  production: boolean;
}

export function deploymentTarget(mode: string | undefined): DeploymentTarget {
  switch (mode) {
    case 'production':
      return { suffix: '', appEnv: 'production', deployed: true, production: true };
    case 'staging':
      return { suffix: '-staging', appEnv: 'staging', deployed: true, production: false };
    default:
      return { suffix: '-dev', appEnv: 'development', deployed: false, production: false };
  }
}
