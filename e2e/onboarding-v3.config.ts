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
 *
 * Billing is hermetic (synthetic Stripe keys, no plan prices): the trial turn is
 * proven against the real routes' real answers, and a trial cannot be completed
 * here, so the number and the test call are proven by component and shell tests.
 *
 * Speech is hermetic the same way (S3-6): TTS_PROVIDER=fixture makes the API
 * speak every line as one bundled 200 ms silent mp3 (a non-production provider
 * at the vendor boundary), so the browser really plays a clip after the tap
 * while the voice routes, the clip cache, the per-clip charge and the audit run
 * for real. Live transcription has no key here (POST /api/voice/stream-token
 * answers 503), so the tap-only path is what is proven for listening.
 *
 * WebKit (iPhone 13) is a second project, opt-in with E2E_V3_WEBKIT=1 because
 * it needs `npx playwright install --with-deps webkit`. It runs the voice spec
 * only. Browser-specific tests are tagged and filtered per project (never
 * skipped at run time: scripts/release/verify.mjs fails a run with any skip):
 * `@webkit` runs only on WebKit, `@chromium` (the fake microphone) only on Chromium.
 */
const apiPort = process.env.E2E_V3_API_PORT ?? '3011';
const webPort = process.env.E2E_V3_WEB_PORT ?? '5176';
const databaseUrl = process.env.E2E_V3_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/serviceos_e2e';
const apiURL = `http://127.0.0.1:${apiPort}`;
const baseURL = `http://127.0.0.1:${webPort}`;

// Tells the spec it is on the stack it needs; it skips itself under any other config.
process.env.E2E_ONBOARDING_V3_STACK = '1';
// Where the spec reaches the API directly (to pin what the billing routes really answer).
process.env.E2E_V3_API_URL = apiURL;

export default defineConfig({
  testDir: './',
  testMatch: ['onboarding-v3-ready-readback.spec.ts', 'onboarding-v3-voice-webkit.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  outputDir: '../test-results/onboarding-v3',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: 'onboarding-v3',
      grepInvert: /@webkit/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          ...(process.env.QA_CHROMIUM_PATH ? { executablePath: process.env.QA_CHROMIUM_PATH } : {}),
          // A fake microphone, so a test that grants the permission can open one (S3-5). A test that does not
          // grant it is refused, as an owner who taps "Don't allow" is: headless Chromium would otherwise leave
          // the prompt unanswered forever, which no owner can do to a visible prompt.
          args: ['--use-fake-device-for-media-stream', '--deny-permission-prompts'],
        },
      },
    },
    ...(process.env.E2E_V3_WEBKIT === '1'
      ? [
          {
            // iOS Safari's engine: autoplay only after a gesture, and audio/mp4 recording.
            name: 'onboarding-v3-webkit',
            testMatch: ['onboarding-v3-voice-webkit.spec.ts'],
            grepInvert: /@chromium/,
            use: { ...devices['iPhone 13'] },
          },
        ]
      : []),
  ],
  webServer: [
    {
      // Prepare the database (create, migrate, seed one price tier), then boot the API on it.
      command: 'npx tsx e2e/fixtures/onboarding-v3-prepare-db.ts && cd packages/api && npm run dev',
      cwd: '../',
      url: `${apiURL}/health`,
      reuseExistingServer: false,
      // ts-node compiles the whole API at boot: ~60 s alone, measured at 192 s on a shared runner.
      timeout: 360_000,
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
        // Rivet's voice: the dev-only fixture provider (refused in production), so a clip really plays
        // after the tap with no vendor key. It wins over any vendor key in a developer's own shell.
        TTS_PROVIDER: 'fixture',
        DATABASE_URL: databaseUrl,
        E2E_V3_DATABASE_URL: databaseUrl,
        // The lane's Postgres is local and plain (CI sets the same at job level); without it every
        // query fails "The server does not support SSL connections" while /health still answers.
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
