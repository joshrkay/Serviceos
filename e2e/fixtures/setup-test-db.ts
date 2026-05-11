/**
 * Ephemeral test-DB setup for the e2e/journeys/* suite.
 *
 * Strategy: testcontainers-first, BYO-Postgres fallback.
 *
 *   1. If DATABASE_URL is set AND looks like a test DB → just migrate it.
 *      (CI mode — caller provisioned a clean Postgres service / branch.)
 *   2. Else → spin up a pgvector/pgvector:pg16 testcontainer locally,
 *      apply migrations, and print its connection string. The caller is
 *      expected to capture E2E_DB_URL from stdout (or read it from the
 *      pidfile this script writes).
 *
 * Idempotent: re-running against an already-migrated DB is a no-op because
 * every migration uses IF NOT EXISTS / DROP POLICY IF EXISTS.
 *
 * Usage (local, with testcontainer):
 *   npx tsx e2e/fixtures/setup-test-db.ts
 *
 * Usage (CI, with an existing test Postgres):
 *   DATABASE_URL=postgres://...test... npx tsx e2e/fixtures/setup-test-db.ts
 *
 * Output: writes JSON state to e2e/fixtures/.test-db-state.json containing
 * { connectionString, containerId? } for teardown to pick up. Also prints
 * `export DATABASE_URL=...` so callers can `eval $(npx tsx ...)`.
 *
 * Flags:
 *   --dry-run    print what it would do without connecting / starting containers
 */
import { writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { checkDatabaseUrlSafety, exitIfUnsafe, redact } from './safety';

// We resolve paths relative to the script's expected location (e2e/fixtures/).
// Scripts are invoked via `npm run e2e:db:*` from the repo root, so process.cwd()
// is the repo root and this layout holds.
const FIXTURES_DIR = resolve(process.cwd(), 'e2e', 'fixtures');
const STATE_FILE = join(FIXTURES_DIR, '.test-db-state.json');
const SCHEMA_TS_PATH = resolve(process.cwd(), 'packages', 'api', 'src', 'db', 'schema.ts');
const LOOSE_MIGRATIONS_DIR = resolve(process.cwd(), 'packages', 'api', 'src', 'db', 'migrations');

interface TestDbState {
  connectionString: string;
  // Container ID only present when WE started the container.
  // Teardown uses this to stop it. Absent in CI mode.
  containerId?: string;
  // True when we own the container and teardown should stop it.
  ownsContainer: boolean;
}

const isDryRun = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  const userProvidedUrl = process.env.DATABASE_URL;

  if (isDryRun) {
    console.log('[setup-test-db] --dry-run mode — no connections, no containers.');
    if (userProvidedUrl) {
      const decision = checkDatabaseUrlSafety(userProvidedUrl);
      console.log(`[setup-test-db] would check safety on: ${decision.url}`);
      console.log(`[setup-test-db] decision: ${decision.allowed ? 'ALLOW' : 'REFUSE'} — ${decision.reason}`);
      if (decision.allowed) {
        console.log('[setup-test-db] would apply MIGRATIONS object + loose .sql files to this DB.');
      }
    } else {
      console.log('[setup-test-db] DATABASE_URL not set — would start a pgvector/pgvector:pg16 testcontainer.');
      console.log('[setup-test-db] would apply MIGRATIONS object + loose .sql files to it.');
    }
    console.log(`[setup-test-db] would write state to ${STATE_FILE}`);
    console.log('[setup-test-db] dry-run OK');
    return;
  }

  let state: TestDbState;

  if (userProvidedUrl) {
    const decision = checkDatabaseUrlSafety(userProvidedUrl);
    exitIfUnsafe(decision);
    state = { connectionString: userProvidedUrl, ownsContainer: false };
  } else {
    state = await startTestcontainer();
  }

  await applyMigrations(state.connectionString);
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  // Emit a shell-eval-able line so callers can pick up the URL.
  console.log('[setup-test-db] ready');
  console.log(`export DATABASE_URL=${state.connectionString}`);
}

async function startTestcontainer(): Promise<TestDbState> {
  console.log('[setup-test-db] starting pgvector/pgvector:pg16 testcontainer (~10s)…');
  // Dynamic import so the heavy testcontainers dep isn't required when
  // the caller is passing their own DATABASE_URL.
  const tc = await import('@testcontainers/postgresql').catch((err) => {
    console.error('[setup-test-db] @testcontainers/postgresql is not installed.');
    console.error('[setup-test-db] Either install it as a devDependency or set DATABASE_URL to a pre-provisioned test DB.');
    throw err;
  });
  const image = process.env.POSTGRES_IMAGE || 'pgvector/pgvector:pg16';
  const container = await new tc.PostgreSqlContainer(image)
    .withDatabase('serviceos_e2e_test')
    .start();
  const connectionString = container.getConnectionUri();
  console.log(`[setup-test-db] container up: ${redact(connectionString)}`);
  return {
    connectionString,
    containerId: container.getId(),
    ownsContainer: true,
  };
}

async function applyMigrations(connectionString: string): Promise<void> {
  // Late-import to keep dry-run zero-cost.
  const { getMigrationSQL } = await import(SCHEMA_TS_PATH);
  const client = new Client({
    connectionString,
    ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = '60s'");
    console.log('[setup-test-db] applying schema.ts MIGRATIONS…');
    await client.query(getMigrationSQL());
    console.log('[setup-test-db] applying loose .sql migrations…');
    if (existsSync(LOOSE_MIGRATIONS_DIR)) {
      const files = readdirSync(LOOSE_MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      for (const f of files) {
        const sql = readFileSync(join(LOOSE_MIGRATIONS_DIR, f), 'utf8');
        try {
          await client.query(sql);
          console.log(`[setup-test-db]   applied ${f}`);
        } catch (err) {
          // Loose migrations may already be folded into MIGRATIONS — surface
          // but don't fail on idempotency-friendly errors.
          const code = (err as { code?: string }).code;
          if (code === '42701' /* duplicate_column */ || code === '42710' /* duplicate_object */) {
            console.log(`[setup-test-db]   skipped ${f} (already applied: ${code})`);
            continue;
          }
          throw err;
        }
      }
    }
    console.log('[setup-test-db] migrations complete');
  } finally {
    await client.end();
  }
}

function shouldUseSsl(connectionString: string): boolean {
  // testcontainers ⇒ no SSL. Anything matching *.railway / *.rlwy / supabase ⇒ SSL.
  return /railway|rlwy|supabase|amazonaws|heroku/i.test(connectionString);
}

main().catch((err) => {
  console.error('[setup-test-db] failed:', err);
  process.exit(1);
});
