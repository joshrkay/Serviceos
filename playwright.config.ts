import { defineConfig, devices } from '@playwright/test';
import type { DevAuthFixtures } from './e2e/helpers/dev-auth';

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

// Hermetic webhook secret for the always-on browser Journey-1
// (e2e/journeys/signup-to-first-estimate.hermetic.spec.ts). A base64 `whsec_`
// TEST value — NOT a real Clerk secret — so the spec's signed `user.created`
// webhook verifies against the in-process API on every PR runner. The spec
// reads the same constant (E2E_CLERK_WEBHOOK_SECRET, same default).
const E2E_CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ??
  'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';

// The API webServer runs in DEV_AUTH_BYPASS mode (NODE_ENV=dev) so the hermetic
// journey's browser session — an UNSIGNED JWT minted by the Clerk stub — is
// accepted and resolved to the webhook-bootstrapped tenant
// (packages/api/src/auth/dev-auth-bypass.ts). NODE_ENV/DEV_AUTH_BYPASS are set
// firmly (not `?? inherited`) because dev-auth-bypass fails CLOSED — an
// inherited NODE_ENV=test would silently disable it and the always-on journey
// would go red. This is confined to the API process and invisible to every
// other e2e spec: the offline money-loop / no-401 specs mock all `/api/*` at
// the browser via page.route, so the real API's auth mode never runs for them.
// It is also additive to any real-Clerk path — verifyClerkSession runs FIRST,
// and the bypass no-ops (`if (req.auth) return next()`) for genuinely
// authenticated requests, so it never weakens a real session's assertions.
// CLERK_WEBHOOK_SECRET enables the real /webhooks/clerk route (overridable so a
// real Clerk dev instance's secret still wins).
const apiWebServerEnv: NodeJS.ProcessEnv = {
  ...webServerEnv,
  NODE_ENV: 'dev',
  DEV_AUTH_BYPASS: 'true',
  CLERK_WEBHOOK_SECRET: process.env.CLERK_WEBHOOK_SECRET ?? E2E_CLERK_WEBHOOK_SECRET,
};
const includeQaMatrix = process.env.QA_MATRIX === '1';
// Lever 3 of the QA strategy — see qa/reports/2026-05-11/coverage-sweep-runbook.md.
// Opt-in to avoid running it on every PR; it visits every authenticated route
// and requires a real running stack (or E2E_BASE_URL pointing at one).
const includeCoverageSweep = process.env.COVERAGE_SWEEP === '1';
// UI flow capture — screenshots every screen for docs/ui-flows. Opt-in via
// UI_FLOW=1 (set by `npm run ui-flow:capture`) so the default e2e run skips it.
const includeUiFlow = !!process.env.UI_FLOW;

// ── D-2: chromium-devauth — run the Clerk-gated / auth-gated specs against
// the repo's own dev test-auth mode instead of self-skipping (see
// e2e/README.md and packages/web/.claude/skills/verify/SKILL.md). Needs its
// own API + vite pair (VITE_AUTH_MODE=dev aliases @clerk/clerk-react to a
// local shim — see packages/web/vite.config.ts — so it cannot share the
// legacy pair's alias-free vite build), hence its own ports. Skipped when
// E2E_BASE_URL points at a deployed env (nothing local to boot against) or
// when explicitly disabled with E2E_DEV_AUTH=0.
const includeDevAuth = !skipWebServer && process.env.E2E_DEV_AUTH !== '0';
const devAuthWebPort = process.env.E2E_DEVAUTH_WEB_PORT ?? '5174';
const devAuthApiPort = process.env.E2E_DEVAUTH_API_PORT ?? '3001';
const devAuthBaseURL = `http://127.0.0.1:${devAuthWebPort}`;
const devAuthApiURL = `http://127.0.0.1:${devAuthApiPort}`;
// Exposed for e2e/fixtures/dev-auth-seed.setup.ts (same Node process — this
// config and every test/setup file run in it) so the seed script's target
// stays in sync with the ports above instead of a second hardcoded copy.
process.env.E2E_DEVAUTH_API_URL = devAuthApiURL;
process.env.E2E_DEVAUTH_BASE_URL = devAuthBaseURL;

const devAuthApiServerEnv: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'dev',
  DEV_AUTH_BYPASS: 'true',
  PORT: devAuthApiPort,
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  TELEPHONY_ENABLED: 'false',
  EMAIL_ENABLED: 'false',
  // Force InMemory repos regardless of any DATABASE_URL/E2E_USE_TEST_DB set
  // for the legacy webServer pair — dev-auth specs run against seeded
  // InMemory data (verify-seed.mjs), never a real/ephemeral Postgres.
  DATABASE_URL: undefined,
  E2E_USE_TEST_DB: undefined,
};

const devAuthWebServerEnv: NodeJS.ProcessEnv = {
  ...process.env,
  VITE_AUTH_MODE: 'dev',
  VITE_DEV_AUTH_SUB: process.env.E2E_DEVAUTH_SUB ?? 'dev_owner',
  VITE_DEV_AUTH_ROLE: process.env.E2E_DEVAUTH_ROLE ?? 'owner',
  // Placeholder — the dev-auth vite.config.ts alias swaps out @clerk/clerk-react
  // entirely, so the value is never read, but main.tsx's P0-026 startup guard
  // still requires it to be present (see packages/web/src/main.tsx).
  VITE_CLERK_PUBLISHABLE_KEY: process.env.VITE_CLERK_PUBLISHABLE_KEY ?? 'pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA==',
  VITE_API_URL: devAuthApiURL,
  VITE_ONBOARDING_V2_ENABLED: 'false',
};

export default defineConfig<DevAuthFixtures>({
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
    ...(includeDevAuth
      ? [
          {
            // Seeds InMemory data over HTTP against the dev-auth API
            // (packages/api/scripts/verify-seed.mjs) once that pair is up —
            // see e2e/fixtures/dev-auth-seed.setup.ts. Runs once before every
            // chromium-devauth test via `dependencies` below.
            name: 'devauth-setup',
            testDir: './e2e',
            testMatch: ['**/dev-auth-seed.setup.ts'],
            testIgnore: [],
          },
          {
            // D-2 — runs the Clerk-key / authenticated-stack-gated specs for
            // real against the dev test-auth stack (VITE_AUTH_MODE=dev +
            // DEV_AUTH_BYPASS=true) instead of self-skipping —
            // e2e/helpers/dev-auth.ts's `devAuthActive` fixture (true only
            // here, via `use` below) is what makes them run.
            //
            // Scoped to exactly those specs via testMatch, NOT the whole
            // e2e/ dir like `chromium`: every other spec is either already
            // always-on under `chromium` (and would just run twice for no
            // benefit) or itself needs real Clerk secrets (the
            // journeys/onboarding-v2*/signup-to-first-estimate.spec.ts /
            // technician-phone-mobile family — out of scope, see
            // e2e/README.md). Some of the always-on ones are actively
            // incompatible here: the hermetic signup journey's signed
            // webhook needs CLERK_WEBHOOK_SECRET, which is only wired into
            // the LEGACY api webServer's env (apiWebServerEnv) — running it
            // against devAuthApiServerEnv (no webhook secret) fails, not
            // because dev-auth is broken but because that spec was never
            // meant to run against this pair.
            name: 'chromium-devauth',
            testDir: './e2e',
            testMatch: [
              'booking-mobile.spec.ts',
              'estimate-approval-mobile.spec.ts',
              'invoice-payment-mobile.spec.ts',
              'comms-inbox-mobile.spec.ts',
              'review-response-approval-mobile.spec.ts',
              'job-scheduling-mobile.spec.ts',
              'settings-mobile.spec.ts',
            ],
            testIgnore: [],
            dependencies: ['devauth-setup'],
            use: {
              ...devices['Desktop Chrome'],
              baseURL: devAuthBaseURL,
              devAuthActive: true,
              ...(process.env.QA_CHROMIUM_PATH
                ? { launchOptions: { executablePath: process.env.QA_CHROMIUM_PATH } }
                : {}),
            },
          },
        ]
      : []),
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
          env: apiWebServerEnv,
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
        // D-2 — dedicated pair for chromium-devauth (own ports; see
        // includeDevAuth above). Always listed when includeDevAuth is true
        // regardless of which --project filter is passed, same as the pair
        // above — Playwright starts every configured webServer once per run.
        ...(includeDevAuth
          ? [
              {
                command: 'cd packages/api && npm run dev',
                url: `${devAuthApiURL}/health`,
                reuseExistingServer: !isCI,
                timeout: 120_000,
                stdout: 'pipe' as const,
                stderr: 'pipe' as const,
                env: devAuthApiServerEnv,
              },
              {
                command: `cd packages/web && npm run dev -- --port ${devAuthWebPort} --host 127.0.0.1 --strictPort`,
                url: devAuthBaseURL,
                reuseExistingServer: !isCI,
                timeout: 120_000,
                stdout: 'pipe' as const,
                stderr: 'pipe' as const,
                env: devAuthWebServerEnv,
              },
            ]
          : []),
      ],
});
