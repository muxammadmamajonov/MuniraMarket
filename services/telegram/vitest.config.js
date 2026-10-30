import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fake = (file) => fileURLToPath(new URL(`./test/sdk-fake/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    // The `sdk` specifiers only exist inside the Telegram Serverless runtime; tests resolve them
    // to a local double that mimics the documented surface.
    alias: [
      { find: /^sdk$/, replacement: fake('index.js') },
      { find: /^sdk\/db$/, replacement: fake('db.js') },
      { find: /^sdk\/api$/, replacement: fake('api.js') },
      { find: /^sdk\/fetch$/, replacement: fake('fetch.js') },
    ],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
  },
});
