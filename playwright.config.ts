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

// §10 — when Clerk journey tests run, default v2 on for the Vite dev server unless
// the caller already set the flag explicitly.
if (
  process.env.E2E_CLERK_SECRET_KEY &&
  process.env.VITE_ONBOARDING_V2_ENABLED === undefined
) {
  process.env.VITE_ONBOARDING_V2_ENABLED = 'true';
}

const webServerEnv: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL,
  E2E_USE_TEST_DB: process.env.E2E_USE_TEST_DB,
  VITE_ONBOARDING_V2_ENABLED: process.env.VITE_ONBOARDING_V2_ENABLED,
  VITE_CLERK_PUBLISHABLE_KEY:
    process.env.VITE_CLERK_PUBLISHABLE_KEY ?? process.env.E2E_CLERK_PUBLISHABLE_KEY,
};
const includeQaMatrix = process.env.QA_MATRIX === '1';
// Lever 3 of the QA strategy — see qa/reports/2026-05-11/coverage-sweep-runbook.md.
// Opt-in to avoid running it on every PR; it visits every authenticated route
// and requires a real running stack (or E2E_BASE_URL pointing at one).
const includeCoverageSweep = process.env.COVERAGE_SWEEP === '1';
// UI flow capture — screenshots every screen for docs/ui-flows. Opt-in via
// UI_FLOW=1 (set by `npm run ui-flow:capture`) so the default e2e run skips it.
const includeUiFlow = !!process.env.UI_FLOW;

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
      // Exclude both the qa-matrix specs (their own project) and the
      // coverage-sweep spec (opt-in via the dedicated project below) so
      // the default `npm run e2e` does not run them.
      testIgnore: ['**/qa-matrix/**', '**/coverage-sweep.spec.ts', '**/ui-flow-capture*.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        // Same escape hatch the qa-matrix project has: runners whose
        // pre-baked chromium build differs from the installed Playwright's
        // expected build (and can't download) point QA_CHROMIUM_PATH at the
        // existing binary. No-op when unset.
        ...(process.env.QA_CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.QA_CHROMIUM_PATH } }
          : {}),
      },
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
            // testMatch order is for readability, NOT a guaranteed run order
            // (under workers:1 Playwright may order files alphabetically). Specs
            // are written to be self-contained — each seeds its own
            // customer/location/job and provisions its own vertical — so no row
            // depends on another having run first; precheck is a fail-fast gate
            // but each row also validates its own prerequisites.
            testMatch: [
              'precheck.spec.ts',
              'provisioning.spec.ts',
              'customers.spec.ts',
              'estimates.spec.ts',
              'billing-journey.spec.ts',
              'payments-edge.spec.ts',
              'invoices.spec.ts',
              'public-portal.spec.ts',
              'proposals.spec.ts',
              'reports.spec.ts',
              'jobs.spec.ts',
              'agreements.spec.ts',
              'leads.spec.ts',
              'invoices-lifecycle.spec.ts',
              'customers-archive.spec.ts',
              'feature-flags.spec.ts',
              'time-entries.spec.ts',
              'settings.spec.ts',
              'notes.spec.ts',
              'catalog.spec.ts',
              'conversations.spec.ts',
              'locations.spec.ts',
              'estimate-revise.spec.ts',
              'appointments-lifecycle.spec.ts',
              'me.spec.ts',
              'maintenance-contracts.spec.ts',
              'golden-journey.spec.ts',
              'scheduling.spec.ts',
              'sms.spec.ts',
              'voice-extras.spec.ts',
              'voice-billing.spec.ts',
              'isolation.spec.ts',
              'assistant.spec.ts',
            ],
            // Browsers in the image (build 1194) can differ from the installed
            // Playwright's expected build. QA_CHROMIUM_PATH lets a run point at
            // an existing full-chromium binary (headless works without the
            // separate headless-shell). No-op when unset.
            use: {
              ...devices['Desktop Chrome'],
              ...(process.env.QA_CHROMIUM_PATH
                ? { launchOptions: { executablePath: process.env.QA_CHROMIUM_PATH } }
                : {}),
            },
          },
        ]
      : []),
    ...(includeCoverageSweep
      ? [
          {
            // Lever-3 coverage sweep — visits every authenticated route and
            // asserts (a) no console / page errors, (b) primary buttons are
            // wired to a handler, (c) data fetches return 2xx. Opt-in via
            // COVERAGE_SWEEP=1 (set by `npm run e2e:coverage-sweep`).
            // See qa/reports/2026-05-11/coverage-sweep-runbook.md.
            name: 'coverage-sweep',
            testDir: './e2e',
            testMatch: ['coverage-sweep.spec.ts'],
            testIgnore: [],
            use: { ...devices['Desktop Chrome'] },
          },
        ]
      : []),
    ...(includeUiFlow
      ? [
          {
            // UI flow capture — screenshots every screen into docs/ui-flows.
            // Opt-in via UI_FLOW=1 (`npm run ui-flow:capture`).
            name: 'ui-flow',
            testDir: './e2e',
            testMatch: ['ui-flow-capture.spec.ts', 'ui-flow-capture-mobile.spec.ts'],
            testIgnore: [],
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
          env: webServerEnv,
        },
        {
          command: 'cd packages/web && npm run dev',
          url: baseURL,
          reuseExistingServer: !isCI,
          timeout: 120_000,
          stdout: 'pipe',
          stderr: 'pipe',
          env: webServerEnv,
        },
      ],
});
