/**
 * Vitest globalSetup for integration tests.
 *
 * Starts the Postgres testcontainer ONCE per `vitest run`, applies migrations
 * once, and exposes the connection string via TEST_DB_URL. Per-file
 * beforeAll/afterAll then just connect/disconnect a Pool against this single
 * container — no per-file container lifecycle.
 *
 * pgvector/pgvector:pg16 is the canonical Postgres 16 image with the `vector`
 * extension preloaded — required by migration 062 (knowledge_chunks). The
 * plain postgres:16-alpine image lacks the extension and fails
 * `CREATE EXTENSION vector` at schema apply time.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { getMigrationSQL } from '../../src/db/schema';

let container: StartedPostgreSqlContainer | null = null;

async function applyMigrations(uri: string): Promise<void> {
  const bootstrap = new Pool({ connectionString: uri });
  try {
    await bootstrap.query("SET lock_timeout = '5s'");
    await bootstrap.query("SET statement_timeout = '25s'");
    await bootstrap.query(getMigrationSQL());
  } finally {
    await bootstrap.end();
  }
}

export async function setup(): Promise<void> {
  // Honor an externally-provided Postgres (CI service container, or a local
  // cluster in sandboxes where the Docker registry is unreachable). When
  // EXTERNAL_TEST_DB_URL is set we apply migrations to it and skip the
  // testcontainer entirely — same migration path, just a different host. The
  // connecting role must be a superuser, mirroring the testcontainer default.
  const externalUri = process.env.EXTERNAL_TEST_DB_URL;
  if (externalUri) {
    await applyMigrations(externalUri);
    process.env.TEST_DB_URL = externalUri;
    return;
  }

  const image = process.env.POSTGRES_IMAGE || 'pgvector/pgvector:pg16';
  container = await new PostgreSqlContainer(image)
    .withDatabase('serviceos_test')
    // Integration files run in a single fork (vitest.integration.config.ts);
    // several open their own app DB pool via createApp() and don't close it,
    // so connections accumulate across the ~58-file run and exhaust the
    // default 100 slots ("sorry, too many clients already", FATAL 53300) on
    // the last file. Raise the ceiling — the container is ephemeral and torn
    // down after the run. Follow-up: close app pools in each test's afterAll.
    .withCommand(['postgres', '-c', 'max_connections=300'])
    .start();

  const uri = container.getConnectionUri();
  await applyMigrations(uri);

  process.env.TEST_DB_URL = uri;
}

export async function teardown(): Promise<void> {
  if (container) {
    await container.stop();
    container = null;
  }
}
