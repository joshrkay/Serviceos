/**
 * Prepares the real Postgres that e2e/onboarding-v3.config.ts boots the API
 * against: creates the database when missing, applies every migration (the same
 * path journeys use, via setupTestDb), and seeds the one Cleveland plumbing
 * price tier the spec asserts on. Idempotent; safe to re-run against a used DB.
 *
 *   npx tsx e2e/fixtures/onboarding-v3-prepare-db.ts
 *
 * E2E_V3_DATABASE_URL defaults to postgres://postgres:postgres@localhost:5432/serviceos_e2e.
 * The URL must pass e2e/fixtures/safety.ts (a test-looking database name).
 */
import { Client } from 'pg';
import { checkDatabaseUrlSafety, exitIfUnsafe } from './safety';
import { setupTestDb } from './setup-test-db';

export const DEFAULT_V3_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/serviceos_e2e';

/** What most Cleveland plumbers charge in the fixture: $89 to come out, then $150 an hour. */
const CLEVELAND_PLUMBING_TIER = {
  standard: { tripFeeCents: 8900, hourlyRateCents: 15000 },
  premium: { tripFeeCents: 12900, hourlyRateCents: 18500 },
};

async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.replace(/^\//, ''));
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (found.rowCount === 0) await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
  } finally {
    await client.end();
  }
}

async function seedTier(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO regional_price_tiers (trade, metro_code, tier, source, updated_at)
       VALUES ('plumbing', 'CLE', $1::jsonb, 'e2e fixture', NOW())
       ON CONFLICT (trade, metro_code) DO UPDATE SET tier = EXCLUDED.tier, source = EXCLUDED.source, updated_at = NOW()`,
      [JSON.stringify(CLEVELAND_PLUMBING_TIER)],
    );
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const url = process.env.E2E_V3_DATABASE_URL ?? DEFAULT_V3_DATABASE_URL;
  exitIfUnsafe(checkDatabaseUrlSafety(url));
  await ensureDatabase(url);
  // setupTestDb migrates the DATABASE_URL it is handed; scope that to this call.
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;
  try {
    await setupTestDb();
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
  await seedTier(url);
  console.log('[onboarding-v3] database ready');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
