import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Integration files share one Postgres cluster; run them sequentially to
    // stay under connection limits.
    fileParallelism: false,
  },
});
