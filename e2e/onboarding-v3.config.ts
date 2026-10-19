import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the "pick, don't build" onboarding shell (v3), run
 * against the REAL stack: the API on a real Postgres, and the SPA in the repo's
 * dev test-auth mode (VITE_AUTH_MODE=dev + DEV_AUTH_BYPASS=true, see
 * packages/web/.claude/skills/verify/SKILL.md) with the v3 flag on. Nothing is
 * mocked: the draft is created, read, and approved through the real routes into
 * real tables.
 *
 * Also runs invoice-payment-collect-on-site.spec.ts (S5a-2): the public invoice
 * page and portal on a business that collects in person, on the same real stack.
 *
 * Separate from playwright.config.ts on purpose: that config boots InMemory
 * pairs and has no v3 flag. Own ports, so it never adopts another lane's server.
 *
 *   QA_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
 *     npx playwright test -c e2e/onboarding-v3.config.ts
 *
 * Optional: E2E_V3_DATABASE_URL (default postgres://postgres:postgres@localhost:5432/serviceos_e2e),
 * E2E_V3_API_PORT (3011), E2E_V3_WEB_PORT (5176), E2E_V3_SERVER_TIMEOUT_MS (180000, the API's boot).
 *
 * Billing is hermetic (synthetic Stripe keys, no plan prices): the trial turn is
 * proven against the real routes' real answers, and a trial cannot be completed
 * here, so the number and the test call are proven by component and shell tests.
 */
const apiPort = process.env.E2E_V3_API_PORT ?? '3011';
const webPort = process.env.E2E_V3_WEB_PORT ?? '5176';
const databaseUrl = process.env.E2E_V3_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/serviceos_e2e';
const apiURL = `http://127.0.0.1:${apiPort}`;
const baseURL = `http://127.0.0.1:${webPort}`;
// How long the API may take to migrate and boot. ts-node compiles the whole API on start, which takes minutes
// on a loaded shared machine; E2E_V3_SERVER_TIMEOUT_MS raises it there without changing what CI waits for.
const serverTimeout = Number(process.env.E2E_V3_SERVER_TIMEOUT_MS ?? 180_000);

// Tells the spec it is on the stack it needs; it skips itself under any other config.
process.env.E2E_ONBOARDING_V3_STACK = '1';
// Where the spec reaches the API directly (to pin what the billing routes really answer).
process.env.E2E_V3_API_URL = apiURL;

export default defineConfig({
  testDir: './',
  testMatch: ['onboarding-v3-ready-readback.spec.ts', 'onboarding-v3-voice-webkit.spec.ts'],
  testMatch: ['onboarding-v3-ready-readback.spec.ts', 'invoice-payment-collect-on-site.spec.ts'],
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
    launchOptions: {
      ...(process.env.QA_CHROMIUM_PATH ? { executablePath: process.env.QA_CHROMIUM_PATH } : {}),
      // A fake microphone, so a test that grants the permission can open one (S3-5). A test that does not
      // grant it is refused, as an owner who taps "Don't allow" is: headless Chromium would otherwise leave
      // the prompt unanswered forever, which no owner can do to a visible prompt.
      args: ['--use-fake-device-for-media-stream', '--deny-permission-prompts'],
    },
  },
  projects: [{ name: 'onboarding-v3' }],
  webServer: [
    {
      // Prepare the database (create, migrate, seed one price tier), then boot the API on it.
      command: 'npx tsx e2e/fixtures/onboarding-v3-prepare-db.ts && cd packages/api && npm run dev',
      cwd: '../',
      url: `${apiURL}/health`,
      reuseExistingServer: false,
      timeout: serverTimeout,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        ...process.env,
        NODE_ENV: 'dev',
        DEV_AUTH_BYPASS: 'true',
        PORT: apiPort,
        LOG_LEVEL: 'warn',
        TELEPHONY_ENABLED: 'false',
        // On so an invoice send can complete (only a send mints the invoice's view
        // token, which the S5a-2 spec opens). Nothing leaves the box: NODE_ENV=dev
        // gets the in-memory delivery provider, which only records the dispatch
        // (packages/api/src/notifications/delivery-provider-factory.ts).
        EMAIL_ENABLED: 'true',
        // The same hermetic Stripe environment CI runs in (.github/workflows/onboarding-database.yml):
        // synthetic keys, so billing exists but no request ever reaches Stripe. No plan prices are
        // set (blanked, so a developer's own shell cannot change that), so the billing routes answer
        // "not configured" and checkout cannot complete; the trial turn shows exactly that.
        STRIPE_SECRET_KEY: 'sk_test_hermetic_release',
        STRIPE_WEBHOOK_SECRET: 'whsec_hermetic_release',
        STRIPE_STARTER_PRICE_ID: '',
        STRIPE_GROWTH_PRICE_ID: '',
        STRIPE_PRICE_ID: '',
        // No live transcription in the lane (blanked so a developer's own key cannot open a real socket):
        // POST /api/voice/stream-token answers 503 and the shell's tap-only path is what is proven.
        DEEPGRAM_API_KEY: '',
        DATABASE_URL: databaseUrl,
        E2E_V3_DATABASE_URL: databaseUrl,
        // The local test Postgres speaks no SSL; the pool asks for it unless told not to (db/pool.ts).
        DB_SSL: process.env.DB_SSL ?? 'false',
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
