/**
 * Playwright globalTeardown — runs after every test in the run finishes.
 *
 * Two opt-in responsibilities, mirroring global-setup.ts:
 *
 *   1. Ephemeral test DB teardown (DB-fixtures-agent block, below):
 *      Active when E2E_USE_TEST_DB=true. Stops the testcontainer or
 *      truncates all tables on the BYO Postgres URL. Idempotent.
 *
 *   2. QA matrix report builder (QA-matrix-agent block, below):
 *      Active when QA_MATRIX=1. Delegates to the existing report-builder
 *      module so its previous teardown contract is preserved.
 *
 * Both blocks are independent. Default runs no-op.
 */
import { spawnSync } from 'node:child_process';

export default async function globalTeardown(): Promise<void> {
  // --- BEGIN: ephemeral-DB block (owned by DB-fixtures agent) ---
  if (process.env.E2E_USE_TEST_DB === 'true') {
    console.log('[e2e globalTeardown] E2E_USE_TEST_DB=true — tearing down ephemeral DB…');
    const teardown = spawnSync('npx', ['tsx', 'e2e/fixtures/teardown-test-db.ts'], {
      cwd: process.cwd(),
      stdio: 'inherit',
    });
    if (teardown.status !== 0) {
      // Don't throw — teardown failure shouldn't mask test failures.
      console.warn(`[e2e globalTeardown] teardown-test-db.ts exited ${teardown.status}`);
    }
  }
  // --- END: ephemeral-DB block ---

  // --- BEGIN: QA matrix report builder block (owned by QA matrix agent) ---
  if (process.env.QA_MATRIX === '1') {
    // Late-import so the bare e2e run doesn't load QA-matrix-only code.
    // Resolve from cwd (repo root) to dodge ESM extension-less import quirks.
    const path = await import('node:path');
    const reportBuilderPath = path.resolve(
      process.cwd(),
      'e2e',
      'qa-matrix',
      'helpers',
      'report-builder.ts'
    );
    const mod = await import(reportBuilderPath);
    const fn = (mod as { default?: () => Promise<void> }).default;
    if (typeof fn === 'function') {
      await fn();
    }
  }
  // --- END: QA matrix report builder block ---
}
