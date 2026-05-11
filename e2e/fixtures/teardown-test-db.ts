/**
 * Teardown for the e2e/journeys/* ephemeral test DB.
 *
 * Behavior depends on how setup-test-db.ts started it:
 *
 *   - testcontainer mode (we own the container, state file says
 *     ownsContainer=true):  stop + remove the container.
 *   - BYO mode (DATABASE_URL was passed in, we don't own it): truncate every
 *     data table back to empty. Schema is preserved. Safe to re-run.
 *
 * Refuses to run when the DB URL looks like production. Always safe to call
 * multiple times — missing state file or missing tables are non-fatal.
 *
 * Flags:
 *   --dry-run   print intended actions without doing them.
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { checkDatabaseUrlSafety, exitIfUnsafe } from './safety';

const FIXTURES_DIR = resolve(process.cwd(), 'e2e', 'fixtures');
const STATE_FILE = join(FIXTURES_DIR, '.test-db-state.json');
const ENV_FILE = join(FIXTURES_DIR, '.journey-fixtures.env');

interface TestDbState {
  connectionString: string;
  containerId?: string;
  ownsContainer: boolean;
}

const isDryRun = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  if (isDryRun) {
    console.log('[teardown-test-db] --dry-run mode — no actions taken.');
    if (existsSync(STATE_FILE)) {
      const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as TestDbState;
      console.log(`[teardown-test-db] state file present (ownsContainer=${state.ownsContainer})`);
      console.log(`[teardown-test-db] would ${state.ownsContainer ? 'STOP CONTAINER' : 'TRUNCATE TABLES'}`);
    } else {
      console.log('[teardown-test-db] no state file — would no-op.');
    }
    return;
  }

  if (!existsSync(STATE_FILE)) {
    console.log('[teardown-test-db] no state file — nothing to do.');
    return;
  }

  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as TestDbState;

  if (state.ownsContainer && state.containerId) {
    await stopContainer(state.containerId);
  } else {
    await truncateAllTables(state.connectionString);
  }

  // Clean up state files
  try { unlinkSync(STATE_FILE); } catch { /* ignore */ }
  try { unlinkSync(ENV_FILE); } catch { /* ignore */ }
  console.log('[teardown-test-db] done');
}

async function stopContainer(containerId: string): Promise<void> {
  console.log(`[teardown-test-db] stopping container ${containerId.slice(0, 12)}…`);
  // testcontainers exposes the underlying dockerode client; we use the
  // npm 'testcontainers' root package's getContainerRuntimeClient() helper
  // to avoid hard-coding docker socket paths.
  try {
    const mod = await import('testcontainers');
    const runtime = await mod.getContainerRuntimeClient();
    await runtime.container.getById(containerId).stop({ t: 5 });
    await runtime.container.getById(containerId).remove({ force: true });
    console.log('[teardown-test-db] container stopped + removed');
  } catch (err) {
    console.warn('[teardown-test-db] failed to stop container via testcontainers; you may need to docker rm -f manually.');
    console.warn(err);
  }
}

async function truncateAllTables(connectionString: string): Promise<void> {
  const decision = checkDatabaseUrlSafety(connectionString);
  exitIfUnsafe(decision);

  const client = new Client({
    connectionString,
    ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    // Skip system / extension / migration tables so:
    //   - PostGIS's spatial_ref_sys (read-only, owned by the extension) doesn't blow up TRUNCATE.
    //   - Migration tracking tables (__drizzle_migrations, knex_migrations,
    //     pgmigrations, schema_migrations) survive so the DB stays
    //     pre-migrated for the next run — much faster than re-applying.
    const SYSTEM_TABLES = [
      'spatial_ref_sys',
      '__drizzle_migrations',
      'knex_migrations',
      'knex_migrations_lock',
      'pgmigrations',
      'schema_migrations',
    ];
    const res = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename NOT IN (${SYSTEM_TABLES.map((_, i) => `$${i + 1}`).join(', ')})
       ORDER BY tablename`,
      SYSTEM_TABLES
    );
    const tables = res.rows.map((r) => r.tablename);
    if (tables.length === 0) {
      console.log('[teardown-test-db] no tables to truncate.');
      return;
    }

    // RLS prevents some bulk deletes — sidestep it for this admin op when
    // the session has the permission. Managed Postgres services (RDS,
    // Railway, Supabase non-service-role) reject this with code 42501
    // (insufficient_privilege); CASCADE still gets us through because
    // we're truncating all tenant-scoped data simultaneously, so any FK
    // chains resolve. We just lose the RLS bypass — not a correctness
    // problem for TRUNCATE-with-CASCADE on a fresh test DB.
    let replicationRoleSet = false;
    try {
      await client.query("SET session_replication_role = 'replica'");
      replicationRoleSet = true;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '42501') {
        console.warn(
          '[teardown-test-db] session_replication_role=replica refused (insufficient_privilege). ' +
            'TRUNCATE will still run with CASCADE; ensure your test DB user has TRUNCATE rights.'
        );
      } else {
        throw err;
      }
    }

    const quoted = tables.map((t) => `"${t}"`).join(', ');
    console.log(`[teardown-test-db] TRUNCATE ${tables.length} tables…`);
    await client.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);

    if (replicationRoleSet) {
      try {
        await client.query("SET session_replication_role = 'origin'");
      } catch {
        /* best-effort restore; session ends below anyway */
      }
    }
    console.log('[teardown-test-db] truncate complete');
  } finally {
    await client.end();
  }
}

function shouldUseSsl(connectionString: string): boolean {
  return /railway|rlwy|supabase|amazonaws|heroku/i.test(connectionString);
}

main().catch((err) => {
  console.error('[teardown-test-db] failed:', err);
  process.exit(1);
});
