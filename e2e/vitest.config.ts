import { defineConfig } from 'vitest/config';

/**
 * Vitest project for E2E *helper* unit tests only (e.g. clerk-env.test.ts).
 *
 * The E2E dir is NOT an npm workspace, so it's outside the root
 * vitest.workspace.ts. This standalone config lets `npm run test:e2e-helpers`
 * (and the CI step in .github/workflows/e2e.yml) run the pure-logic tests for
 * the harness helpers WITHOUT pulling in the Playwright `*.spec.ts` files —
 * hence include is scoped to `*.test.ts` and spec files are excluded.
 */
export default defineConfig({
  test: {
    root: __dirname,
    include: ['**/*.test.ts'],
    exclude: ['**/*.spec.ts', '**/node_modules/**'],
    environment: 'node',
  },
});
