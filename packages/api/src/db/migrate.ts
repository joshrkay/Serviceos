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
    return; // let event loop drain; process exits 0 naturally
  }
  const pool = createPool();
  try {
    await pool.query(getMigrationSQL());
    console.log('Migrations completed successfully');
  } catch (err) {
    if (isDuplicatePolicyError(err)) {
      console.warn('Migration warning: duplicate policy detected, continuing startup');
    } else {
      console.error('Migration failed:', err);
      process.exitCode = 1;
    }
  } finally {
    // pool.end() can hang indefinitely on Railway's PostgreSQL.
    // Race it against a 5-second timeout so the process always exits cleanly
    // and the shell chain can proceed to start index.js.
    await Promise.race([
      pool.end(),
      new Promise<void>(resolve => setTimeout(resolve, 5_000)),
    ]);
  }
}

runMigrations();
