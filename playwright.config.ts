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

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/qa-matrix/**'],
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
    {
      // 4-agent swarm QA matrix (Estimates, Invoices, Assistant).
      // Run with: npm run e2e:qa-matrix
      // Requires: E2E_BASE_URL, E2E_API_URL, Clerk tokens for two tenants,
      // Stripe test keys on the API, and E2E_DB_URL_READONLY for Agent C.
      // See qa/README.md.
      name: 'qa-matrix',
      testDir: './e2e/qa-matrix',
      testIgnore: [],
      testMatch: ['precheck.spec.ts', 'estimates.spec.ts', 'invoices.spec.ts', 'assistant.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  globalTeardown: process.env.QA_MATRIX === '1'
    ? './e2e/qa-matrix/helpers/report-builder.ts'
    : undefined,

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
