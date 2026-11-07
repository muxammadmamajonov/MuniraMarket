import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests always run. Integration tests (test/integration) need TEST_DATABASE_URL pointing at a
// throw-away local PostgreSQL migrated with Alembic (`make -C ../api migrate`); they skip otherwise.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^sdk$/,
        replacement: fileURLToPath(new URL('./src/scheduler/telegramSdk.ts', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration files share one database; run files one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
