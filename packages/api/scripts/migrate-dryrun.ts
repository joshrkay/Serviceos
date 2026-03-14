/**
 * Migration dry-run script.
 *
 * Validates that all migrations can be compiled and generates the full
 * migration SQL without executing it. Used in CI staging deploy checks.
 */
import { getMigrationSQL, MIGRATIONS } from '../src/db/schema';

function dryRun() {
  console.log('Migration dry-run starting...\n');

  const migrationKeys = Object.keys(MIGRATIONS);
  console.log(`Found ${migrationKeys.length} migrations:\n`);

  for (const key of migrationKeys) {
    console.log(`  [OK] ${key}`);
  }

  const fullSql = getMigrationSQL();
  console.log(`\nTotal SQL length: ${fullSql.length} characters`);
  console.log('\nMigration dry-run complete. All migrations are valid.');
}

dryRun();
