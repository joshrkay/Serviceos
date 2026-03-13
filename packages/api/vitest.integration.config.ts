import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    root: '.',
    include: ['test/integration/**/*.test.ts'],
    passWithNoTests: true,
    testTimeout: 60000,
    hookTimeout: 120000,
    // Integration tests run sequentially to avoid port conflicts
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
