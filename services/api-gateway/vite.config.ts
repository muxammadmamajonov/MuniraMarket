import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

// The Worker, its bindings and the container come from cloudflare.config.ts.
export default defineConfig({
  resolve: {
    // The Cron Trigger bundles ../telegram/tgcloud/lib/ (shared with the Telegram Serverless bot).
    // Their only `sdk` import is `BotApiError`; it resolves to this Worker's stand-in.
    alias: [
      {
        find: /^sdk$/,
        replacement: fileURLToPath(new URL('./src/telegramSdk.ts', import.meta.url)),
      },
    ],
  },
  plugins: [cloudflare()],
});
