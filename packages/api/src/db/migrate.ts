import { createPool } from './pool';
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

async function runMigrations(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE_URL not set — skipping migrations');
    return;
  }
  const pool = createPool();
  const client = await pool.connect();
  try {
    // Prevent DDL lock waits from stalling startup: ALTER TABLE ENABLE RLS and
    // CREATE POLICY acquire ACCESS EXCLUSIVE locks. If the previous deployment
    // still has open connections, these will queue indefinitely without timeouts.
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = '25s'");
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
    // pool.end() can hang; race it against a 5-second timeout.
    await Promise.race([
      pool.end(),
      new Promise<void>(resolve => setTimeout(resolve, 5_000)),
    ]);
  }
}

runMigrations();
