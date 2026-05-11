import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for ServiceOS E2E tests.
 *
 * Runs against either:
 *   - Local dev servers started automatically (default, when E2E_BASE_URL is unset)
 *   - A deployed environment (Railway dev/staging) — set E2E_BASE_URL=https://...
 *
 * See e2e/README.md for the full setup.
 */

const isCI = !!process.env.CI;
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const apiURL = process.env.E2E_API_URL ?? 'http://localhost:3000';
const skipWebServer = !!process.env.E2E_BASE_URL;
const includeQaMatrix = process.env.QA_MATRIX === '1';

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/qa-matrix/**'],
  // globalSetup runs once before any test. It primes the Clerk testing-token
  // flow when E2E_CLERK_* env vars are present, and is a no-op otherwise so
  // smoke tests still run on a bare runner. See e2e/global-setup.ts.
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 2 : 1,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  outputDir: 'test-results',

  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  projects: [
    {
      name: 'chromium',
      testDir: './e2e',
      testIgnore: ['**/qa-matrix/**'],
      use: { ...devices['Desktop Chrome'] },
    },
    ...(includeQaMatrix
      ? [
          {
            // 4-agent swarm QA matrix (Estimates, Invoices, Assistant).
            // Opt-in via QA_MATRIX=1 (set by `npm run e2e:qa-matrix`) so the
            // default e2e run skips it — its specs need env vars and a real
            // backend that aren't wired into PR CI.
            name: 'qa-matrix',
            testDir: './e2e/qa-matrix',
            testIgnore: [],
            testMatch: ['precheck.spec.ts', 'estimates.spec.ts', 'invoices.spec.ts', 'assistant.spec.ts'],
            use: { ...devices['Desktop Chrome'] },
          },
        ]
      : []),
  ],

  // globalTeardown is the mirror of globalSetup — handles both the ephemeral
  // DB cleanup (when E2E_USE_TEST_DB=true) and the QA matrix report builder
  // (when QA_MATRIX=1). Each branch is no-op when its env flag is absent.
  globalTeardown: './e2e/global-teardown.ts',

  webServer: skipWebServer
    ? undefined
    : [
        {
          command: 'cd packages/api && npm run dev',
          url: `${apiURL}/health`,
          reuseExistingServer: !isCI,
          timeout: 120_000,
          stdout: 'pipe',
          stderr: 'pipe',
        },
        {
          command: 'cd packages/web && npm run dev',
          url: baseURL,
          reuseExistingServer: !isCI,
          timeout: 120_000,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      ],
});
