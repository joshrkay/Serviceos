import { createPool } from './pool';
import { getMigrationSQL } from './schema';

async function runMigrations(): Promise<void> {
  const pool = createPool();
  try {
    await pool.query(getMigrationSQL());
    console.log('Migrations completed successfully');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigrations();
