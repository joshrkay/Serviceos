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
    // globalSetup starts the Postgres testcontainer once per `vitest run`
    // and applies migrations. See test/integration/global-setup.ts.
    globalSetup: ['./test/integration/global-setup.ts'],
    // Integration tests run sequentially to avoid port conflicts
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
