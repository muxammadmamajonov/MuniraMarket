import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

// The Worker, its bindings and the container come from cloudflare.config.ts.
export default defineConfig({
  plugins: [cloudflare()],
});
