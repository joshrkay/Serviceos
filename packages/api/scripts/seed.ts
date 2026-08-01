/**
 * Demo-data seed script — inserts a realistic multi-tenant dataset into the
 * database via the production repositories (not a stub: this actually writes
 * rows). Defaults produce 200 customers, 200 estimates, and 200 appointments
 * spread over 10 tenants, with every appointment on a separate day at a
 * separate time (see src/seed/seed-plan.ts for the scheduling guarantee).
 *
 * Usage:
 *   DATABASE_URL=postgres://… npx tsx packages/api/scripts/seed.ts
 *   …                          --tenant-count=10 --per-tenant=20
 *   …                          --timezone=America/Chicago
 *
 * Each entity chain is customer → service location → job → estimate →
 * appointment, so the seeded org has a coherent schedule, pipeline, and CRM.
 */
import { createPool } from '../src/db/pool';
import { runSeed, cleanSeed } from '../src/seed/seed-runner';

function intArg(name: string, fallback: number): number {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!raw) return fallback;
  const value = parseInt(raw.split('=')[1], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function strArg(name: string): string | undefined {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  return raw ? raw.split('=')[1] : undefined;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL && !process.env.DB_HOST) {
    process.stderr.write('seed: DATABASE_URL (or DB_HOST) must be set\n');
    process.exit(1);
  }

  const tenantCount = intArg('tenant-count', 10);
  const customersPerTenant = intArg('per-tenant', 20);
  const timezone = strArg('timezone');
  const isClean = process.argv.includes('--clean');

  const pool = createPool();
  const out = (line: string) => process.stdout.write(line + '\n');
  try {
    if (isClean) {
      out('Cleaning seeded demo tenants…');
      const { tenantsRemoved } = await cleanSeed(pool, out);
      out(`\nClean complete: removed ${tenantsRemoved} seeded tenant(s).`);
      return;
    }
    const result = await runSeed(pool, { tenantCount, customersPerTenant, timezone }, out);
    out('\nSeed complete:');
    out(`  tenants:      ${result.tenantIds.length}`);
    out(`  customers:    ${result.customers}`);
    out(`  estimates:    ${result.estimates}`);
    out(`  appointments: ${result.appointments}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  process.stderr.write(`seed failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
