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
    // Integration tests run sequentially to avoid port conflicts. Vitest 4
    // removed `poolOptions` (pool rework); `maxWorkers`/`minWorkers: 1` pins a
    // single fork so files run one at a time — the same effect the old
    // `poolOptions.forks.singleFork` gave. `isolate: false` keeps every file in
    // the one fork context (matching singleFork), so module singletons like the
    // shared pg pool are created once.
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    isolate: false,
  },
});
