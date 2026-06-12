import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(__dirname, 'migrations');

/**
 * Applies versioned SQL migration files in lexical order. Each file runs in
 * its own transaction and is recorded in schema_migrations; re-running is a
 * no-op. Runs on the privileged (admin) connection.
 */
export async function runMigrations(adminUrl: string): Promise<string[]> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['rivet_migrations']);
    const done = new Set(
      (await client.query('SELECT version FROM schema_migrations')).rows.map(
        (r: { version: string }) => r.version,
      ),
    );
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['rivet_migrations']);
  } finally {
    await client.end();
  }
  return applied;
}

if (require.main === module) {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_ADMIN_URL (or DATABASE_URL) is required');
    process.exit(1);
  }
  runMigrations(url)
    .then((applied) => {
      console.log(
        applied.length > 0 ? `applied: ${applied.join(', ')}` : 'schema up to date',
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
