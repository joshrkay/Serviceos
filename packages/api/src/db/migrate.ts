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

// Hard kill after 30 s — prevents pool.end() or a slow query from hanging the
// shell chain and blocking index.js from starting.
const killTimer = setTimeout(() => {
  console.error('migrate.js: timed out after 30 s — forcing exit');
  process.exit(0);
}, 30_000);
killTimer.unref(); // don't keep the event loop alive for this alone

async function runMigrations(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE_URL not set — skipping migrations');
    process.exit(0);
  }
  const pool = createPool();
  try {
    await pool.query(getMigrationSQL());
    console.log('Migrations completed successfully');
    process.exit(0); // skip pool.end() — it can hang; the process is ending anyway
  } catch (err) {
    if (isDuplicatePolicyError(err)) {
      console.warn('Migration warning: duplicate policy detected, continuing startup');
      process.exit(0);
    }
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

runMigrations();
