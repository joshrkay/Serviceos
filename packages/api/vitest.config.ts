import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    root: '.',
    include: ['test/**/*.test.ts'],
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
    // Integration tests use a separate config
    testTimeout: 30000,
  },
});
