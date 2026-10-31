import { cloudflare } from '@cloudflare/vite-plugin';
import { fileURLToPath } from 'node:url';
import vinext from 'vinext';
import { defineConfig } from 'vite';
import { coreApiBindingPlugin } from '../../infra/cloudflare/vinext.mts';

/**
 * Cloudflare Workers build of the admin (vinext). `next dev` / `next build` do not read this
 * file; they keep working as before. `--mode staging|production` selects the deployment in
 * cloudflare.config.ts.
 */
export default defineConfig({
  plugins: [
    coreApiBindingPlugin(fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '')),
    vinext(),
    cloudflare({
      // Own inspector port per app, so the storefront and admin previews can run side by side
      // (CI starts both; the default 9229 would collide).
      inspectorPort: 9231,
      viteEnvironment: {
        name: 'rsc',
        childEnvironments: ['ssr'],
      },
    }),
  ],
});
