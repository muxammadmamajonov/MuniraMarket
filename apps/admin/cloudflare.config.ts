import { bindings, defineConfig, defineWorker } from 'cf/config';
import { deploymentTarget } from '../../infra/cloudflare/environments.mts';
import {
  apiInternalUrl,
  domainsFrom,
  observability,
  vinextAssets,
} from '../../infra/cloudflare/vinext.mts';

/**
 * Admin (back office) Worker (vinext). `--mode staging` / `--mode production` select
 * the deployment; any other mode is local development against the developer's Core API.
 *
 * The Core API is reached through the `CORE_API` service binding to the gateway's
 * `AdminApi` entrypoint (never the public internet; the browser still only talks to this
 * origin). The public hostname comes from `MM_ADMIN_HOSTNAME` at deploy time; nothing here is
 * secret.
 */
export default defineConfig(({ mode }) => {
  const target = deploymentTarget(mode);
  return {
    worker: defineWorker({
      name: `muniramarket-admin${target.suffix}`,
      entrypoint: 'vinext/server/fetch-handler',
      compatibilityDate: '2026-10-30',
      compatibilityFlags: ['nodejs_compat'],
      assets: vinextAssets(),
      domains: domainsFrom(target, 'MM_ADMIN_HOSTNAME'),
      // Deployed Workers are only reachable on their custom domain: a workers.dev or preview URL
      // would be an extra origin that is not in CSRF_TRUSTED_ORIGINS or the Login Widget domain.
      workersDev: !target.deployed,
      previewUrls: false,
      observability: observability(target),
      env: {
        ASSETS: bindings.assets(),
        CORE_API: target.deployed
          ? bindings.worker({
              worker: `muniramarket-api-gateway${target.suffix}`,
              exportName: 'AdminApi',
            })
          : null,
        API_INTERNAL_URL: bindings.text(apiInternalUrl(target)),
        // Cloudflare overwrites CF-Connecting-IP on every request; a client cannot set it.
        CLIENT_IP_HEADER: bindings.text('cf-connecting-ip'),
      },
    }),
  };
});
