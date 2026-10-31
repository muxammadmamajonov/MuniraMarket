import { cloudflare } from '@cloudflare/vite-plugin';
import { fileURLToPath } from 'node:url';
import vinext from 'vinext';
import { defineConfig } from 'vite';
import { coreApiBindingPlugin } from '../../infra/cloudflare/vinext.mts';

/**
 * Cloudflare Workers build of the storefront (vinext). `next dev` / `next build` do not read this
 * file; they keep working as before. `--mode staging|production` selects the deployment in
 * cloudflare.config.ts.
 */
export default defineConfig({
  plugins: [
    coreApiBindingPlugin(fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '')),
    vinext(),
    cloudflare({
      viteEnvironment: {
        name: 'rsc',
        childEnvironments: ['ssr'],
      },
    }),
  ],
});
