import { defineConfig, devices } from '@playwright/test';
import { requireReleaseCredentials } from './scripts/release/verification-policy.mjs';

requireReleaseCredentials(process.env);
// Fixed Development destination. No production signup, payment or provider mutations.
export default defineConfig({
  testDir: './e2e/release',
  testMatch: 'onboarding.spec.ts',
  globalSetup: './e2e/release/setup.ts',
  retries: 0,
  workers: 1,
  forbidOnly: true,
  timeout: 120_000,
  reporter: [['list'], ['json', { outputFile: 'test-results/release-results.json' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'https://serviceosweb-development.up.railway.app',
    // Auth traces contain tokens. Keep them out of uploadable release artifacts.
    trace: 'off', video: 'off', screenshot: 'off',
  },
});
