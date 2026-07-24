import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { createPool, createDirectPool } from './pool';
import { getMigrationSQL } from './schema';

interface PgLikeError {
  code?: string;
  routine?: string;
  message?: string;
}

function isDuplicatePolicyError(err: unknown): err is PgLikeError {
  if (!err || typeof err !== 'object') return false;
  const maybePgError = err as PgLikeError;
  return maybePgError.code === '42710' && maybePgError.routine === 'CreatePolicy';
}

/**
 * DATA-04 — stable int32 key pair for the single global migration advisory
 * lock. Derived from a constant string (NOT a per-run value) so every replica /
 * retried deploy contends on the SAME lock. Mirrors the derivation in
 * proposals/execution/idempotency-lock.ts.
 */
export function migrationAdvisoryKey(): [number, number] {
  const digest = createHash('sha256').update('serviceos:schema-migrations').digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/**
 * DATA-04 — run `fn` while holding a session-level advisory lock so only one
 * migrator touches the schema at a time. Under Railway's restartPolicyMaxRetries
 * + overlapSeconds a second `migrate.js` can start before the first finishes;
 * without this, both run the same ALTER TABLE / CREATE POLICY DDL concurrently.
 *
 * The wait is bounded: `pg_advisory_lock()` blocks indefinitely and is NOT
 * subject to `lock_timeout`, but `statement_timeout` DOES abort a statement
 * blocked waiting on it — so we cap the acquire at 20s (well under the 35s
 * deploy overlap). A stuck holder therefore surfaces as an error (exitCode=1 →
 * Railway retry), never an indefinite hang. The lock is acquired OUTSIDE the
 * try so a failed acquire doesn't run the unlock; it is released in `finally`
 * with its own error swallowed so it can't mask a migration error.
 */
export async function withMigrationAdvisoryLock<T>(
  client: PoolClient,
  fn: () => Promise<T>,
): Promise<T> {
  const [k1, k2] = migrationAdvisoryKey();
  // Bound the blocking acquire; reset to unlimited immediately after so it does
  // not constrain the long-running DDL that follows.
  await client.query("SET statement_timeout = '20s'");
  await client.query('SELECT pg_advisory_lock($1::int, $2::int)', [k1, k2]);
  await client.query("SET statement_timeout = '0'");
  try {
    return await fn();
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [k1, k2]);
    } catch {
      // Best-effort unlock. A broken/aborted session is reset when the
      // connection is released, which also drops the session advisory lock
      // server-side — so never let an unlock failure mask the real outcome.
    }
  }
}

/**
 * Constraints whose ABSENCE after a migration run is a deploy-blocking
 * condition to surface, even though the migration itself "succeeded".
 * `no_double_booking` (migration 131) deliberately skips itself with a
 * RAISE WARNING when pre-existing overlapping assignments are found — a
 * deploy-safety valve that must not stay silent, because without the
 * constraint the double-booking guard is application-level only (F3).
 */
const CRITICAL_CONSTRAINTS = ['no_double_booking'] as const;

/**
 * Return the critical constraints missing from the database. Empty array
 * means every DB-level guard the app assumes is actually in force.
 */
export async function findMissingCriticalConstraints(
  client: PoolClient,
): Promise<string[]> {
  const result = await client.query<{ conname: string }>(
    'SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[])',
    [[...CRITICAL_CONSTRAINTS]],
  );
  const present = new Set(result.rows.map((r) => r.conname));
  return CRITICAL_CONSTRAINTS.filter((c) => !present.has(c));
}

/** Apply the full migration corpus on the given client. Exit-free + testable. */
export async function applyMigrations(client: PoolClient): Promise<void> {
  // Prevent DDL lock waits from stalling startup: ALTER TABLE ENABLE RLS
  // and CREATE POLICY acquire ACCESS EXCLUSIVE locks that can queue if the
  // previous deployment still holds open connections.
  await client.query("SET lock_timeout = '5s'");
  await client.query("SET statement_timeout = '25s'");
  await client.query(getMigrationSQL());
  // Non-fatal by design (the skip is a deliberate valve for legacy-overlap
  // databases) but LOUD: an operator must know the DB-level guard is off.
  const missing = await findMissingCriticalConstraints(client);
  for (const conname of missing) {
    console.error(
      `[migrate] CRITICAL: constraint '${conname}' is ABSENT after migration. ` +
        'Double-booking is NOT enforced at the database level. Reconcile ' +
        'overlapping appointment_assignments rows and re-deploy.',
    );
  }
}

/**
 * Run the migration corpus under the advisory lock on the given client. This is
 * the exit-free core that both `runMigrations()` and the integration test drive;
 * it does NOT own the pool or the process lifecycle.
 */
export async function runMigrationsOnClient(client: PoolClient): Promise<void> {
  await withMigrationAdvisoryLock(client, () => applyMigrations(client));
}

async function runMigrations(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE_URL not set — skipping migrations');
    return;
  }
  // Migrations issue session-scoped `SET lock_timeout` / `SET statement_timeout`
  // and then DDL. Under the PgBouncer topology `DATABASE_URL` points at
  // transaction-mode PgBouncer, where those session settings can land on a
  // DIFFERENT backend than the DDL that follows. Prefer the DIRECT (session)
  // DSN when configured — the same bypass runAsLeader / the idempotency lock /
  // LISTEN-NOTIFY use — and fall back to DATABASE_URL when no direct DSN is set
  // (single-instance / no PgBouncer; identical to prior behavior).
  // (Codex P1, PR #628.)
  const pool = createDirectPool() ?? createPool();
  const client = await pool.connect();
  try {
    // DATA-04 — take the migration advisory lock so concurrent/retried deploys
    // can't race the same DDL. The lock is session-scoped on THIS connection and
    // released before the connection is returned to the pool.
    await runMigrationsOnClient(client);
    console.log('Migrations completed successfully');
  } catch (err) {
    if (isDuplicatePolicyError(err)) {
      console.warn('Migration warning: duplicate policy detected, continuing startup');
    } else {
      console.error('Migration failed:', err);
      process.exitCode = 1;
    }
  } finally {
    client.release();
    // pool.end() can hang indefinitely. Race it against a 5-second timeout.
    // IMPORTANT: after the race we must call process.exit() explicitly —
    // if the timer wins, pool.end() is still pending in the event loop and
    // will keep the process alive forever, preventing index.js from starting.
    await Promise.race([
      pool.end(),
      new Promise<void>(resolve => setTimeout(resolve, 5_000)),
    ]);
    process.exit(process.exitCode ?? 0);
  }
}

// Only auto-run when invoked as the migration entrypoint, not when imported by
// tests. `require.main === module` is true only for `node .../migrate.js`.
if (require.main === module) {
  runMigrations();
}
