import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Pure modules only (routing policy, Bot API adapter, scheduler orchestration); no Workers APIs.
export default defineConfig({
  resolve: {
    // Same alias as vite.config.ts: the shared Telegram modules import `BotApiError` from `sdk`.
    alias: [
      {
        find: /^sdk$/,
        replacement: fileURLToPath(new URL('./src/telegramSdk.ts', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
