/**
 * Ephemeral test-DB setup for the e2e/journeys/* suite.
 *
 * Strategy: testcontainers-first, BYO-Postgres fallback.
 *
 *   1. If DATABASE_URL is set AND looks like a test DB → just migrate it.
 *      (CI mode — caller provisioned a clean Postgres service / branch.)
 *   2. Else → spin up a pgvector/pgvector:pg16 testcontainer locally,
 *      apply migrations, and print its connection string.
 *
 * Idempotent: re-running against an already-migrated DB is a no-op because
 * every migration uses IF NOT EXISTS / DROP POLICY IF EXISTS.
 *
 * Two entry points:
 *   - `setupTestDb()` — async function imported by Playwright globalSetup
 *     so the testcontainer lives for the lifetime of the Playwright
 *     process. Returns the held container ref so globalTeardown can stop
 *     it cleanly in the same process. This avoids Ryuk killing the
 *     container the moment a child process exits.
 *   - `main()` — CLI wrapper for stand-alone use
 *     (`npx tsx e2e/fixtures/setup-test-db.ts`). Writes the state file
 *     so a separate teardown invocation can find the container.
 *
 * Usage (local, with testcontainer):
 *   npx tsx e2e/fixtures/setup-test-db.ts
 *
 * Usage (CI, with an existing test Postgres):
 *   DATABASE_URL=postgres://...test... npx tsx e2e/fixtures/setup-test-db.ts
 *
 * Output: writes JSON state to e2e/fixtures/.test-db-state.json containing
 * { connectionString, containerId? } for the CLI teardown to pick up.
 *
 * Flags:
 *   --dry-run    print what it would do without connecting / starting containers
 */
import { writeFileSync, readdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { checkDatabaseUrlSafety, exitIfUnsafe, redact } from './safety';

const FIXTURES_DIR = resolve(process.cwd(), 'e2e', 'fixtures');
const STATE_FILE = join(FIXTURES_DIR, '.test-db-state.json');
const SCHEMA_TS_PATH = resolve(process.cwd(), 'packages', 'api', 'src', 'db', 'schema.ts');
const LOOSE_MIGRATIONS_DIR = resolve(process.cwd(), 'packages', 'api', 'src', 'db', 'migrations');

export interface TestDbState {
  connectionString: string;
  // Container ID only present when WE started the container.
  // The CLI teardown reads this; the in-process teardown uses the held
  // container ref directly.
  containerId?: string;
  // True when we own the container and teardown should stop it.
  ownsContainer: boolean;
}

// Minimal shape of the testcontainers PostgreSqlContainer we care about.
// Typed locally so the module compiles without @testcontainers/postgresql
// being a peer dep — the dep is dynamically imported on demand.
interface StartedPgContainer {
  getConnectionUri(): string;
  getId(): string;
  stop(opts?: { timeout?: number; remove?: boolean }): Promise<unknown>;
}

// Module-level reference to the running testcontainer when we own it.
// globalSetup populates this; globalTeardown reads it in the same Node
// process. Without this, Ryuk would tear the container down the instant
// a child process exited.
let _heldContainer: StartedPgContainer | undefined;

export function getHeldContainer(): StartedPgContainer | undefined {
  return _heldContainer;
}

/**
 * In-process setup. Used by Playwright globalSetup so the container
 * lifecycle is anchored to the same long-lived Node process.
 */
export async function setupTestDb(): Promise<TestDbState> {
  const userProvidedUrl = process.env.DATABASE_URL;

  let state: TestDbState;
  if (userProvidedUrl) {
    const decision = checkDatabaseUrlSafety(userProvidedUrl);
    exitIfUnsafe(decision);
    state = { connectionString: userProvidedUrl, ownsContainer: false };
  } else {
    state = await startTestcontainer();
  }

  await applyMigrations(state.connectionString);
  return state;
}

/**
 * In-process teardown. Stops the held testcontainer if we started one
 * during setupTestDb(). No-op otherwise (BYO mode owns its own
 * lifecycle — call truncateAllTables from teardown-test-db.ts).
 */
export async function stopHeldContainer(): Promise<void> {
  if (!_heldContainer) return;
  const c = _heldContainer;
  _heldContainer = undefined;
  try {
    await c.stop({ timeout: 5_000, remove: true });
  } catch (err) {
    console.warn('[setup-test-db] failed to stop held container; you may need to docker rm -f manually.');
    console.warn(err);
  }
}

async function startTestcontainer(): Promise<TestDbState> {
  console.log('[setup-test-db] starting pgvector/pgvector:pg16 testcontainer (~10s)…');
  const tc = await import('@testcontainers/postgresql').catch((err) => {
    console.error('[setup-test-db] @testcontainers/postgresql is not installed.');
    console.error('[setup-test-db] Either install it as a devDependency or set DATABASE_URL to a pre-provisioned test DB.');
    throw err;
  });
  const image = process.env.POSTGRES_IMAGE || 'pgvector/pgvector:pg16';
  const container = (await new tc.PostgreSqlContainer(image)
    .withDatabase('serviceos_e2e_test')
    .start()) as unknown as StartedPgContainer;
  _heldContainer = container;
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
  return /railway|rlwy|supabase|amazonaws|heroku/i.test(connectionString);
}

function writeStateFile(state: TestDbState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function clearStateFile(): void {
  try { unlinkSync(STATE_FILE); } catch { /* no-op */ }
}

export { writeStateFile, clearStateFile, STATE_FILE };

const isDryRun = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  if (isDryRun) {
    console.log('[setup-test-db] --dry-run mode — no connections, no containers.');
    const userProvidedUrl = process.env.DATABASE_URL;
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

  const state = await setupTestDb();
  writeStateFile(state);

  // Emit a shell-eval-able line so callers can pick up the URL.
  // NOTE for in-process callers (globalSetup): use setupTestDb() instead —
  // this CLI path will exit() at the end of main(), which triggers Ryuk
  // and tears down the container even if you parsed this output.
  console.log('[setup-test-db] ready');
  console.log(`export DATABASE_URL=${state.connectionString}`);
}

// CLI entry — only when invoked directly via `tsx setup-test-db.ts`.
// When imported (e.g. by global-setup.ts) this block does not run, so
// setupTestDb() may be called without side effects. The CommonJS check
// is sufficient here; mixing in `import.meta.url` previously forced
// Playwright's TypeScript transform into ESM mode and broke `exports`.
const isMainModule =
  typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module;
if (isMainModule) {
  main().catch((err) => {
    console.error('[setup-test-db] failed:', err);
    process.exit(1);
  });
}
