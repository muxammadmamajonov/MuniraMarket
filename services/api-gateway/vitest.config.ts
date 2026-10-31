import { defineConfig } from 'vitest/config';

// Only the pure policy module (`src/routing.ts`) is unit-tested here; it uses no Workers APIs.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
