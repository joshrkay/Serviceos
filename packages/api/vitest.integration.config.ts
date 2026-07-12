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
    // `poolOptions.forks.singleFork` gave. Default per-file ISOLATION is kept
    // deliberately: `singleFork` shared the process but vitest still gave each
    // file its own module registry, which `vi.mock` depends on — with
    // `isolate: false` a file that imports a module unmocked poisons the next
    // file's mock of it (broke onboarding-activation/-vapi funnel spies on
    // PR #670's first CI run). Each file creates/closes its own pg pool via
    // getSharedTestDb/closeSharedTestDb, exactly as under vitest 1.
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
  },
});
