import { createPool } from './pool';
import { getMigrationSQL } from './schema';
import { resolveMigrationConnectionString, usingDedicatedMigrationRole } from './migrate-config';

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

async function runMigrations(): Promise<void> {
  const connectionString = resolveMigrationConnectionString();
  if (!connectionString) {
    console.log('DATABASE_URL/MIGRATION_DATABASE_URL not set — skipping migrations');
    return;
  }
  if (usingDedicatedMigrationRole()) {
    console.log('Running migrations via MIGRATION_DATABASE_URL (dedicated migration role)');
  }
  const pool = createPool(connectionString);
  const client = await pool.connect();
  try {
    // Prevent DDL lock waits from stalling startup: ALTER TABLE ENABLE RLS
    // and CREATE POLICY acquire ACCESS EXCLUSIVE locks that can queue if the
    // previous deployment still holds open connections.
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = '25s'");
    // FORCE ROW LEVEL SECURITY tables carry policies that read
    // current_setting('app.current_tenant_id'). A non-superuser/non-BYPASSRLS
    // migration role evaluates those policies during the data-fixup UPDATEs and
    // errors on the unset GUC ("unrecognized configuration parameter
    // app.current_tenant_id"). Seed a sentinel tenant so they evaluate cleanly:
    // the migration set contains no INSERTs and the fixups touch no rows under
    // the sentinel, and superuser roles bypass RLS so it is a harmless no-op.
    await client.query("SET app.current_tenant_id = '00000000-0000-0000-0000-000000000000'");
    await client.query(getMigrationSQL());
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

runMigrations();
