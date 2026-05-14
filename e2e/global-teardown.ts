/**
 * Playwright globalTeardown — runs after every test in the run finishes.
 *
 * Two opt-in responsibilities, mirroring global-setup.ts:
 *
 *   1. Ephemeral test DB teardown (DB-fixtures block, below):
 *      Active when E2E_USE_TEST_DB=true. If global-setup.ts started a
 *      testcontainer, stops it IN-PROCESS via stopHeldContainer() — same
 *      module state, so it works because Playwright runs setup + tests +
 *      teardown in the same Node process. If we're in BYO mode (no held
 *      container), shells out to the CLI teardown to truncate the DB.
 *
 *   2. QA matrix report builder (QA-matrix block, below):
 *      Active when QA_MATRIX=1. Delegates to the existing report-builder
 *      module so its previous teardown contract is preserved.
 *
 * Both blocks are independent. Default runs no-op.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import buildQaMatrixReport from './qa-matrix/helpers/report-builder';

export default async function globalTeardown(): Promise<void> {
  // --- BEGIN: ephemeral-DB block ---
  if (process.env.E2E_USE_TEST_DB === 'true') {
    await teardownEphemeralDb();
  }
  // --- END: ephemeral-DB block ---

  // --- BEGIN: QA matrix report builder block ---
  if (process.env.QA_MATRIX === '1') {
    // Statically imported at the top of this file: a dynamic import() of a
    // .ts module bypasses Playwright's TS transform and fails with "Cannot
    // use import statement outside a module". report-builder has no
    // import-time side effects, so a top-level import is safe even when the
    // bare e2e run doesn't use it.
    await buildQaMatrixReport();
  }
  // --- END: QA matrix report builder block ---
}

async function teardownEphemeralDb(): Promise<void> {
  console.log('[e2e globalTeardown] E2E_USE_TEST_DB=true — tearing down ephemeral DB…');

  // Lazy-import: matches global-setup.ts and keeps the DB-fixtures dep
  // graph out of the bare smoke path.
  const { getHeldContainer, stopHeldContainer, clearStateFile, STATE_FILE } =
    await import('./fixtures/setup-test-db');

  // Fast path: we started a container in this process, so we have the
  // reference and can stop it cleanly without re-discovering by ID.
  if (getHeldContainer()) {
    await stopHeldContainer();
    clearStateFile();
    console.log('[e2e globalTeardown] held testcontainer stopped');
    return;
  }

  // BYO path: someone provided DATABASE_URL. Truncate via the CLI script
  // (it owns the production-DB safety guard). It's fine to spawn here
  // because we're not relying on the spawned process to hold any
  // long-lived resource.
  if (existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { ownsContainer: boolean };
      if (!state.ownsContainer) {
        const teardown = spawnSync('npx', ['tsx', 'e2e/fixtures/teardown-test-db.ts'], {
          cwd: process.cwd(),
          stdio: 'inherit',
        });
        if (teardown.status !== 0) {
          console.warn(`[e2e globalTeardown] teardown-test-db.ts exited ${teardown.status}`);
        }
      }
    } catch (err) {
      console.warn('[e2e globalTeardown] failed to read state file; skipping BYO teardown.', err);
    }
    try { unlinkSync(STATE_FILE); } catch { /* no-op */ }
  } else {
    console.log('[e2e globalTeardown] no state file and no held container; nothing to do.');
  }
}
