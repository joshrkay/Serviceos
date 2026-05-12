/**
 * Playwright globalSetup — runs once before any test starts.
 *
 * Two opt-in responsibilities so smoke tests on a bare runner still work:
 *
 *   1. Clerk testing tokens (Clerk-agent block, below):
 *      Active when E2E_CLERK_PUBLISHABLE_KEY + E2E_CLERK_SECRET_KEY are set.
 *      Calls clerkSetup() to mint a short-lived testing token. Skip
 *      (warn-only) when missing.
 *
 *   2. Ephemeral test DB (DB-fixtures-agent block, below):
 *      Active when E2E_USE_TEST_DB=true. Runs setupTestDb + seed
 *      IN-PROCESS so the testcontainer's lifetime is anchored to this
 *      long-lived Playwright process. Teardown lives in
 *      e2e/global-teardown.ts and calls stopHeldContainer() on the
 *      same module — so Ryuk doesn't reap the container mid-run.
 *
 * Each block is independent. Smoke runs with neither env set just no-op.
 */

import { clerkSetup } from '@clerk/testing/playwright';

export default async function globalSetup(): Promise<void> {
  // --- BEGIN: ephemeral-DB block ---
  // Activated by E2E_USE_TEST_DB=true. setupTestDb runs in this process
  // (no spawnSync), so the testcontainer it starts survives until
  // global-teardown.ts calls stopHeldContainer() at the end of the run.
  if (process.env.E2E_USE_TEST_DB === 'true') {
    try {
      await bootstrapEphemeralDb();
    } catch (err) {
      // Don't take the whole e2e run down — smoke tests don't need the DB,
      // and journey specs self-skip when their seeded env vars are absent.
      // Loud warning so the operator sees the real cause in CI logs.
      console.error(
        '\n[e2e globalSetup] EPHEMERAL DB BOOTSTRAP FAILED — journey tests ' +
          'will skip themselves. Smoke + journey-agnostic specs will still run.\n' +
          '[e2e globalSetup] Root cause:\n',
        err
      );
      // Clear the env so journey specs notice the failure cleanly.
      process.env.E2E_USE_TEST_DB = '';
      delete process.env.DATABASE_URL;
    }
  }
  // --- END: ephemeral-DB block ---

  // --- BEGIN: Clerk testing-tokens block ---
  // Normalize the env vars we expose in CI to the names @clerk/testing expects.
  // We accept E2E_CLERK_* (preferred for CI, to keep them distinct from any
  // production CLERK_* vars on the same runner) and fall back to the raw names.
  const pubKey = process.env.E2E_CLERK_PUBLISHABLE_KEY ?? process.env.CLERK_PUBLISHABLE_KEY;
  const secretKey = process.env.E2E_CLERK_SECRET_KEY ?? process.env.CLERK_SECRET_KEY;

  if (!pubKey || !secretKey) {
    console.warn(
      '[e2e globalSetup] Clerk testing-token setup skipped — ' +
        'E2E_CLERK_PUBLISHABLE_KEY and/or E2E_CLERK_SECRET_KEY not set. ' +
        'Journey tests that need auth will skip themselves. ' +
        'See qa/reports/2026-05-11/clerk-testing-tokens-runbook.md.'
    );
    return;
  }

  // Make sure the underlying SDK can find the keys regardless of which alias
  // the caller passed. clerkSetup() reads CLERK_PUBLISHABLE_KEY and
  // CLERK_SECRET_KEY (with framework aliases like VITE_/NEXT_PUBLIC_).
  process.env.CLERK_PUBLISHABLE_KEY ??= pubKey;
  process.env.CLERK_SECRET_KEY ??= secretKey;

  // dotenv: false — we don't want @clerk/testing to silently overwrite our
  // env from a stray .env file in CI.
  await clerkSetup({ publishableKey: pubKey, secretKey, dotenv: false });
  // --- END: Clerk testing-tokens block ---
}

async function bootstrapEphemeralDb(): Promise<void> {
  console.log('[e2e globalSetup] E2E_USE_TEST_DB=true — bootstrapping ephemeral DB…');

  // Lazy-import so smoke runs (E2E_USE_TEST_DB unset) never load the
  // testcontainers/pg dependency graph and never trip on this module's
  // own bootstrap issues — only the DB path needs these.
  const { setupTestDb, writeStateFile } = await import('./fixtures/setup-test-db');
  const { seedJourneyFixtures } = await import('./fixtures/seed-journey-fixtures');

  // 1. Start (or adopt) the test DB IN THIS PROCESS. If we own a
  //    container, setupTestDb() stores the ref in module state so
  //    global-teardown.ts can stop it cleanly later.
  const state = await setupTestDb();
  process.env.DATABASE_URL = state.connectionString;
  // Persist the state for CLI-side teardown tools that may run after
  // this process exits in unusual scenarios (e.g. crash-and-recover).
  writeStateFile(state);
  console.log('[e2e globalSetup] DATABASE_URL set from in-process setupTestDb()');

  // 2. Seed the fixtures and apply the IDs directly to process.env so
  //    every spec sees them. The env file is also written for human use.
  const fixtures = await seedJourneyFixtures();
  for (const [k, v] of Object.entries(fixtures.envVars)) {
    process.env[k] = v;
  }
  console.log('[e2e globalSetup] loaded seeded tenant/customer/job/estimate/appointment IDs');
}
