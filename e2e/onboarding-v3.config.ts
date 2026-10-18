import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the "pick, don't build" onboarding shell (v3), run
 * against the REAL stack: the API on a real Postgres, and the SPA in the repo's
 * dev test-auth mode (VITE_AUTH_MODE=dev + DEV_AUTH_BYPASS=true, see
 * packages/web/.claude/skills/verify/SKILL.md) with the v3 flag on. Nothing is
 * mocked: the draft is created, read, and approved through the real routes into
 * real tables.
 *
 * Separate from playwright.config.ts on purpose: that config boots InMemory
 * pairs and has no v3 flag. Own ports, so it never adopts another lane's server.
 *
 *   QA_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
 *     npx playwright test -c e2e/onboarding-v3.config.ts
 *
 * Optional: E2E_V3_DATABASE_URL (default postgres://postgres:postgres@localhost:5432/serviceos_e2e),
 * E2E_V3_API_PORT (3011), E2E_V3_WEB_PORT (5176).
 */
const apiPort = process.env.E2E_V3_API_PORT ?? '3011';
const webPort = process.env.E2E_V3_WEB_PORT ?? '5176';
const databaseUrl = process.env.E2E_V3_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/serviceos_e2e';
const apiURL = `http://127.0.0.1:${apiPort}`;
const baseURL = `http://127.0.0.1:${webPort}`;

// Tells the spec it is on the stack it needs; it skips itself under any other config.
process.env.E2E_ONBOARDING_V3_STACK = '1';

export default defineConfig({
  testDir: './',
  testMatch: ['onboarding-v3-ready-readback.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  outputDir: '../test-results/onboarding-v3',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    ...(process.env.QA_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.QA_CHROMIUM_PATH } } : {}),
  },
  projects: [{ name: 'onboarding-v3' }],
  webServer: [
    {
      // Prepare the database (create, migrate, seed one price tier), then boot the API on it.
      command: 'npx tsx e2e/fixtures/onboarding-v3-prepare-db.ts && cd packages/api && npm run dev',
      cwd: '../',
      url: `${apiURL}/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        ...process.env,
        NODE_ENV: 'dev',
        DEV_AUTH_BYPASS: 'true',
        PORT: apiPort,
        LOG_LEVEL: 'warn',
        TELEPHONY_ENABLED: 'false',
        EMAIL_ENABLED: 'false',
        DATABASE_URL: databaseUrl,
        E2E_V3_DATABASE_URL: databaseUrl,
      },
    },
    {
      command: `cd packages/web && npm run dev -- --port ${webPort} --host 127.0.0.1 --strictPort`,
      cwd: '../',
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        ...process.env,
        VITE_AUTH_MODE: 'dev',
        VITE_DEV_AUTH_ROLE: 'owner',
        // Placeholder: the dev-auth alias replaces @clerk/clerk-react, but main.tsx still requires a key.
        VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA==',
        VITE_API_URL: apiURL,
        VITE_ONBOARDING_V3: 'true',
      },
    },
  ],
});
