/**
 * Coverage threshold configuration per module category.
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
        // Per-module coverage thresholds
        // These thresholds match the PRD Section 13 requirements
        'src/shared/billing-engine.ts': {
          lines: 95,
          branches: 90,
        },
        'src/invoices/payment.ts': {
          lines: 90,
          branches: 85,
        },
        'src/estimates/**': {
          lines: 90,
          branches: 85,
        },
        'src/invoices/invoice.ts': {
          lines: 90,
          branches: 85,
        },
        'src/proposals/execution/**': {
          lines: 85,
          branches: 80,
        },
        'src/auth/**': {
          lines: 85,
          branches: 80,
        },
        'src/middleware/**': {
          lines: 85,
          branches: 80,
        },
        'src/ai/**': {
          lines: 80,
          branches: 75,
        },
        'src/customers/**': {
          lines: 70,
          branches: 65,
        },
        'src/jobs/**': {
          lines: 70,
          branches: 65,
        },
        'src/locations/**': {
          lines: 70,
          branches: 65,
        },
        'src/appointments/**': {
          lines: 70,
          branches: 65,
        },
        'src/notes/**': {
          lines: 70,
          branches: 65,
        },
        'src/conversations/**': {
          lines: 70,
          branches: 65,
        },
      },
    },
  },
});
