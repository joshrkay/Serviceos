import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { CommandBus } from '../../src/core/commands';
import { createDb, type Db } from '../../src/core/db';
import { runMigrations } from '../../src/db/migrate';
import { createTenant } from '../../src/modules/platform/tenants';

const HOST = process.env.TEST_PG_HOST ?? 'localhost';
const ADMIN_USER = process.env.TEST_PG_ADMIN_USER ?? 'postgres';
const ADMIN_PASSWORD = process.env.TEST_PG_ADMIN_PASSWORD ?? 'postgres';
const APP_USER = 'rivet_app';
const APP_PASSWORD = 'rivet_app';

export interface TestDb {
  db: Db;
  bus: CommandBus;
  databaseUrl: string;
  databaseAdminUrl: string;
  destroy(): Promise<void>;
}

/** Creates an isolated database, runs migrations, returns app + admin pools. */
export async function createTestDb(): Promise<TestDb> {
  const name = `rivet_test_${randomBytes(6).toString('hex')}`;
  const root = new Client({
    host: HOST,
    user: ADMIN_USER,
    password: ADMIN_PASSWORD,
    database: 'postgres',
  });
  await root.connect();
  await root.query(`CREATE DATABASE ${name}`);
  await root.end();

  const databaseAdminUrl = `postgres://${ADMIN_USER}:${ADMIN_PASSWORD}@${HOST}:5432/${name}`;
  const databaseUrl = `postgres://${APP_USER}:${APP_PASSWORD}@${HOST}:5432/${name}`;
  await runMigrations(databaseAdminUrl);
  const db = createDb(databaseUrl, databaseAdminUrl);
  const bus = new CommandBus(db);

  return {
    db,
    bus,
    databaseUrl,
    databaseAdminUrl,
    async destroy() {
      await db.close();
      const cleanup = new Client({
        host: HOST,
        user: ADMIN_USER,
        password: ADMIN_PASSWORD,
        database: 'postgres',
      });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

let tenantCounter = 0;

export async function createTestTenant(db: Db, label = 'Test Shop') {
  tenantCounter += 1;
  const suffix = `${Date.now() % 1_000_000}${tenantCounter}`;
  return createTenant(db, {
    name: label,
    phone: `+1999${suffix.padStart(7, '0').slice(-7)}`,
    owner: { name: 'Owner', phone: `+1888${suffix.padStart(7, '0').slice(-7)}` },
  });
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  { timeoutMs = 15_000, intervalMs = 200 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
