/**
 * Coverage threshold configuration per module category (PRD Section 13).
 *
 * Module Category                         | Line Coverage Minimum
 * ----------------------------------------|----------------------
 * Billing engine (shared/billing-engine)  | 95%
 * Payment modules                         | 90%
 * Estimate/invoice calculations           | 90%
 * Proposal execution engine               | 85%
 * Auth/RBAC middleware                     | 85%
 * AI gateway + routing                    | 80%
 * CRUD entities + validation              | 70%
 * UI components                           | 60%
 * Analytics/reporting queries             | 50%
 *
 * Vitest does not support per-file/glob threshold overrides natively.
 * The global threshold below serves as a baseline safety net.
 * Per-module enforcement is handled by scripts/check-coverage.ts
 * which reads the JSON coverage report and validates per-module thresholds.
 *
 * Enforcement: Coverage thresholds are enforced in CI. PRs that drop
 * coverage below the threshold for a module category are blocked.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    root: '.',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      thresholds: {
        // Global minimum — per-module thresholds enforced by check-coverage script
        lines: 50,
      },
    },
  },
});
