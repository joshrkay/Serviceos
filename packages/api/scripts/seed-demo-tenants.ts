/**
 * Seed the demo tenant pool (U7, "pick, don't build" onboarding).
 *
 * Creates DEMO_POOL_PER_TRADE (default 3) demo tenants per trade for the
 * four packs with a shipped seed (plumbing, hvac, electrical, painting), each
 * from the fixture in src/demo/fixture.ts. Idempotent: slots that exist are
 * kept untouched, so it is safe to re-run after the pool size changes.
 *
 * Usage:
 *   DATABASE_URL=postgres://... [DEMO_POOL_PER_TRADE=3] \
 *     npx tsx packages/api/scripts/seed-demo-tenants.ts
 *
 * Refuses in NODE_ENV=production (or prod) unless DEMO_CALLS_ENABLED is on:
 * the pool is only useful where the demo call is switched on, and a seed
 * on a production database is an owner decision, not a default.
 */
import { createPool } from '../src/db/pool';
import { demoPoolPerTrade, demoSeedRefusalReason } from '../src/demo/config';
import { seedDemoTenantPool } from '../src/demo/seed-pool';

function fail(msg: string): never {
  process.stderr.write(`seed-demo-tenants: ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const refusal = demoSeedRefusalReason();
  if (refusal) fail(refusal);
  const perTrade = demoPoolPerTrade();

  const pool = createPool();
  try {
    const result = await seedDemoTenantPool(pool, {
      perTrade,
      log: (line) => process.stdout.write(`${line}\n`),
    });
    process.stdout.write(
      `done: ${result.created} created, ${result.tenantIds.length} demo tenants in the pool (${perTrade} per trade)\n`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
