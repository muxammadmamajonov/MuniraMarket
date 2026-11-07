import { defineConfig } from 'vitest/config';

// Pure modules only (routing policy, forwarding, scheduler orchestration); no Workers APIs.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
