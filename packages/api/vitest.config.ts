import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    root: '.',
    include: ['test/**/*.test.ts'],
    // Integration tests run under vitest.integration.config.ts, which owns
    // the testcontainer lifecycle via globalSetup. Excluding them here means
    // `npm test` (and `npm run test:coverage`) cover unit tests only and
    // don't need Docker.
    exclude: ['node_modules/**', 'dist/**', 'test/integration/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      thresholds: {
        // Module-specific thresholds enforced via vitest.workspace
        // Global minimum as a safety net
        lines: 50,
      },
    },
    testTimeout: 30000,
    hookTimeout: 120000,
  },
});
