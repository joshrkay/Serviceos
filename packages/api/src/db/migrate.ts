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
    console.log('Migrations completed successfully');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void runMigrations();
}
