import { Pool } from 'pg';
import { MIGRATIONS, getMigrationSQL } from './schema';
import { createDatabaseConfig } from './connection';

/**
 * Migration runner for ServiceOS.
 *
 * Migrations are defined as SQL strings in db/schema.ts (MIGRATIONS constant).
 * This runner tracks applied migrations in a `schema_migrations` table and
 * applies any that haven't been run yet, in order.
 *
 * Usage:
 *   npx ts-node src/db/migrate.ts          # run pending migrations
 *   npx ts-node src/db/migrate.ts --status # show migration state
 */

const MIGRATIONS_TABLE = 'schema_migrations';

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(pool: Pool): Promise<Set<string>> {
  const result = await pool.query<{ name: string }>(
    `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY applied_at`
  );
  return new Set(result.rows.map((r) => r.name));
}

async function runMigrations(pool: Pool): Promise<void> {
  await ensureMigrationsTable(pool);
  const applied = await getAppliedMigrations(pool);

  const pending = Object.entries(MIGRATIONS).filter(([name]) => !applied.has(name));

  if (pending.length === 0) {
    console.log('✅ All migrations already applied — nothing to do');
    return;
  }

  console.log(`Running ${pending.length} pending migration(s)...`);

  for (const [name, sql] of pending) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      console.log(`  → ${name}`);
      await client.query(sql);
      await client.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ($1)`,
        [name]
      );
      await client.query('COMMIT');
      console.log(`  ✅ ${name}`);
    } catch (err) {
      await client.query('ROLLBACK');
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ ${name} failed: ${msg}`);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log('\n✅ All migrations complete');
}

async function showStatus(pool: Pool): Promise<void> {
  await ensureMigrationsTable(pool);
  const applied = await getAppliedMigrations(pool);
  const all = Object.keys(MIGRATIONS);

  console.log('\nMigration status:\n');
  for (const name of all) {
    const status = applied.has(name) ? '✅ applied' : '⏳ pending';
    console.log(`  ${status}  ${name}`);
  }
  console.log();
}

async function main(): Promise<void> {
  const env = process.env.NODE_ENV || 'dev';
  const config = createDatabaseConfig(env);

  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
  });

  try {
    const isStatus = process.argv.includes('--status');
    if (isStatus) {
      await showStatus(pool);
    } else {
      await runMigrations(pool);
    }
  } finally {
    await pool.end();
  }
}

// Allow importing as a module or running directly
if (require.main === module) {
  main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

export { runMigrations, showStatus, getMigrationSQL };
