import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

// The Worker and its bindings come from cloudflare.config.ts. The Cron Trigger bundles only the
// dependency-free request signer from ../telegram/tgcloud/lib/coreApi (shared with the bot).
export default defineConfig({
  plugins: [cloudflare()],
});
