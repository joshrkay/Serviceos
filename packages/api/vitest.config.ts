import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    root: '.',
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**'],
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
    // Integration tests also run under this config (test/**/*.test.ts includes
    // test/integration/**). Set hookTimeout high enough to survive a cold Docker
    // image pull (~30-120 s for pgvector/pgvector:pg16 on a fresh CI runner).
    testTimeout: 30000,
    hookTimeout: 120000,
  },
});
