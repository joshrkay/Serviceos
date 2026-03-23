import { MIGRATIONS, SCHEMA_MIGRATIONS_TABLE_SQL } from './schema';

interface QueryResultRow {
  [column: string]: unknown;
}

interface MigrationClient {
  query: (text: string, params?: unknown[]) => Promise<{ rows: QueryResultRow[] }>;
  release: () => void;
}

interface MigrationPool {
  query: (text: string, params?: unknown[]) => Promise<{ rows: QueryResultRow[] }>;
  connect: () => Promise<MigrationClient>;
  end: () => Promise<void>;
}

export async function applyPendingMigrations(
  pool: MigrationPool,
  migrations: Record<string, string> = MIGRATIONS
): Promise<string[]> {
  await pool.query(SCHEMA_MIGRATIONS_TABLE_SQL);

  const existing = await pool.query(
    'SELECT migration_key FROM schema_migrations ORDER BY migration_key ASC'
  );
  const appliedMigrations = new Set(
    existing.rows
      .map((row) => row['migration_key'])
      .filter((key): key is string => typeof key === 'string')
  );

  const appliedThisRun: string[] = [];

  for (const [migrationKey, migrationSql] of Object.entries(migrations)) {
    if (appliedMigrations.has(migrationKey)) {
      continue;
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(migrationSql);
      await client.query(
        'INSERT INTO schema_migrations (migration_key) VALUES ($1) ON CONFLICT (migration_key) DO NOTHING',
        [migrationKey]
      );
      await client.query('COMMIT');
      appliedThisRun.push(migrationKey);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return appliedThisRun;
}

export async function runMigrations(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE_URL not set — skipping migrations');
    return;
  }

  const { createPool } = await import('./pool');
  const pool = createPool();

  try {
    const applied = await applyPendingMigrations(pool);
    if (applied.length === 0) {
      console.log('No pending migrations');
    } else {
      console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
    }
  const client = await pool.connect();
  try {
    // Prevent DDL lock waits from stalling startup: ALTER TABLE ENABLE RLS
    // and CREATE POLICY acquire ACCESS EXCLUSIVE locks that can queue if the
    // previous deployment still holds open connections.
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

if (require.main === module) {
  void runMigrations();
}
