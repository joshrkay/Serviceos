import { defineConfig, devices } from '@playwright/test';

/**
 * Viewport E2E for the mobile app's web export (react-native-web). Pins the
 * CLAUDE.md mobile-UI invariant that doesn't reduce to a jsdom class assertion:
 * no horizontal overflow at 320px. Run via `npm run e2e:viewport`, which builds
 * the export to `.e2e-web` first.
 *
 * The app is Clerk-gated at the root, so content (sign-in, screens) only renders
 * when EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY points at a reachable Clerk instance
 * (provided in CI). Without it the export serves a blank shell; the spec still
 * asserts the document-level no-overflow invariant and skips content/tap-target
 * checks (see mobile-viewport.spec.ts).
 */
const PORT = Number(process.env.MOBILE_E2E_PORT ?? 8788);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  outputDir: '.e2e-results',
  use: {
    baseURL: `http://localhost:${PORT}`,
    // In this sandbox Playwright's browser download is blocked; point at the
    // pre-provisioned chromium when PW_EXECUTABLE_PATH is set. CI uses the
    // bundled browser (unset).
    launchOptions: process.env.PW_EXECUTABLE_PATH
      ? { executablePath: process.env.PW_EXECUTABLE_PATH, args: ['--no-sandbox'] }
      : undefined,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx --yes serve -s .e2e-web -l ${PORT}`,
    cwd: __dirname,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
