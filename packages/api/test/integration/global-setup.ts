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

export async function setup(): Promise<void> {
  const image = process.env.POSTGRES_IMAGE || 'pgvector/pgvector:pg16';
  container = await new PostgreSqlContainer(image)
    .withDatabase('serviceos_test')
    .start();

  const uri = container.getConnectionUri();
  const bootstrap = new Pool({ connectionString: uri });
  try {
    await bootstrap.query("SET lock_timeout = '5s'");
    await bootstrap.query("SET statement_timeout = '25s'");
    await bootstrap.query(getMigrationSQL());
  } finally {
    await bootstrap.end();
  }

  process.env.TEST_DB_URL = uri;
}

export async function teardown(): Promise<void> {
  if (container) {
    await container.stop();
    container = null;
  }
}
