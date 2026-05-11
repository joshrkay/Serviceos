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
 *      Active when E2E_USE_TEST_DB=true. Runs the setup + seed scripts in
 *      e2e/fixtures/, then loads the generated env file so each spec can
 *      read process.env.E2E_TENANT_A_ID, etc. Teardown lives in
 *      e2e/global-teardown.ts.
 *
 * Each block is independent. Smoke runs with neither env set just no-op.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { clerkSetup } from '@clerk/testing/playwright';

export default async function globalSetup(): Promise<void> {
  // --- BEGIN: ephemeral-DB block (owned by DB-fixtures agent) ---
  // Activated by E2E_USE_TEST_DB=true. Edits here should not touch the Clerk
  // block below. Coordinate via comments — see qa/reports/2026-05-11/.
  if (process.env.E2E_USE_TEST_DB === 'true') {
    await bootstrapEphemeralDb();
  }
  // --- END: ephemeral-DB block ---

  // --- BEGIN: Clerk testing-tokens block (owned by Clerk agent) ---
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

// --- BEGIN: ephemeral-DB helpers (owned by DB-fixtures agent) ---

async function bootstrapEphemeralDb(): Promise<void> {
  console.log('[e2e globalSetup] E2E_USE_TEST_DB=true — bootstrapping ephemeral DB…');

  // 1. Run setup-test-db.ts. It either starts a testcontainer or uses an
  //    existing DATABASE_URL. On success it writes .test-db-state.json and
  //    prints `export DATABASE_URL=...` to stdout (we parse that here).
  const setup = spawnSync('npx', ['tsx', 'e2e/fixtures/setup-test-db.ts'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (setup.status !== 0) {
    throw new Error(`[e2e globalSetup] setup-test-db.ts failed (exit ${setup.status})`);
  }
  // Capture exported DATABASE_URL into our own env so child processes
  // (api dev server via webServer) inherit it.
  const exportMatch = setup.stdout.match(/^export DATABASE_URL=(.+)$/m);
  if (exportMatch) {
    process.env.DATABASE_URL = exportMatch[1].trim();
    console.log('[e2e globalSetup] DATABASE_URL set from setup-test-db output');
  }

  // 2. Run the seed. Writes .journey-fixtures.env which we load next.
  const seed = spawnSync('npx', ['tsx', 'e2e/fixtures/seed-journey-fixtures.ts'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (seed.status !== 0) {
    throw new Error(`[e2e globalSetup] seed-journey-fixtures.ts failed (exit ${seed.status})`);
  }

  // 3. Load the seeded IDs into process.env.
  const envFile = join(process.cwd(), 'e2e', 'fixtures', '.journey-fixtures.env');
  if (existsSync(envFile)) {
    const content = readFileSync(envFile, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq);
      const value = trimmed.slice(eq + 1);
      process.env[key] = value;
    }
    console.log('[e2e globalSetup] loaded seeded tenant/customer/job/estimate/appointment IDs');
  } else {
    console.warn(`[e2e globalSetup] expected env file not found: ${envFile}`);
  }
}

// --- END: ephemeral-DB helpers ---
