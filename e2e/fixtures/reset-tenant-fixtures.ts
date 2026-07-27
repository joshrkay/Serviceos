/**
 * Reset (wipe) the QA harness tenants' data back to a clean slate.
 *
 * Problem: e2e/fixtures/seed-journey-fixtures.ts and
 * e2e/qa-matrix/fixtures/seed.ts are purely additive (SELECT-then-INSERT /
 * ON CONFLICT DO NOTHING) against the shared Railway "Development" Postgres
 * DB (E2E_DB_URL_READWRITE, dbname `railway`). Re-running the QA matrix
 * against the same tenants repeatedly accumulates data (extra jobs,
 * estimates, etc.) with no way to get back to a clean slate — which can
 * make later runs fail on ambiguous fuzzy-matches against stale data from
 * earlier runs, not because the thing under test is actually broken.
 *
 * This script deletes ALL rows scoped to the small, closed set of known QA
 * tenants (identified by `tenants.owner_id`, same derivation the two
 * seeders use) from every table that has a `tenant_id` column — and
 * nothing else. It does NOT delete the `tenants` row itself (nor `users`
 * rows are excluded — see below): the tenant/business-data child tables are
 * wiped, but the tenant identity (and anything else NOT scoped by
 * `tenant_id`) is left alone, so a subsequent `npm run qa:setup` re-seeds
 * cleanly (the seeders look up by `owner_id` / natural keys, not by a
 * previously-known tenant UUID, so this is safe either way — but leaving
 * the parent `tenants` row in place keeps the blast radius as small as
 * possible and avoids having to reason about every FK path into `tenants`
 * across the schema).
 *
 * Tenant resolution is EXACT, never a wildcard/LIKE pattern:
 *   1. Compute the closed list of expected `owner_id` values from the same
 *      logic the seeders use (QA_JOURNEY_SEED_PREFIX / QA_MATRIX_SEED_PREFIX,
 *      defaulting to 'qa-journey' / 'qa-matrix').
 *   2. `SELECT id, owner_id FROM tenants WHERE owner_id = ANY($1)` — exact
 *      equality against that closed list only.
 *   3. Defense in depth: every resolved row's owner_id is re-checked against
 *      the closed list before anything is deleted; if the DB ever returned
 *      something outside that list this script refuses to proceed.
 *   4. If NONE of the known QA tenants exist yet (e.g. before the first
 *      `npm run qa:setup`), that's a no-op, not an error.
 *
 * Tenant-scoped tables are discovered at runtime via
 * information_schema (column_name = 'tenant_id', table_schema = 'public')
 * rather than a hardcoded list, so newly-added tenant-scoped tables are
 * automatically covered — the exact set used on a given run is always
 * logged for audit. `tenants` itself has no `tenant_id` column, so it is
 * never a member of this set and is never touched.
 *
 * Deletion runs inside a single transaction. `SET LOCAL
 * session_replication_role = 'replica'` is used (same trick
 * teardown-test-db.ts uses for TRUNCATE) so per-table DELETEs don't need to
 * be topologically sorted against the schema's FK graph — it's
 * transaction-scoped and reverts automatically on COMMIT/ROLLBACK. Any
 * error anywhere rolls back the whole transaction — either every targeted
 * row across every table is deleted, or nothing is.
 *
 * Follows the same production-DB safety gate as the seeders
 * (checkDatabaseUrlSafety from ./safety — requires the DB name to look like
 * a test DB, or E2E_DB_ALLOW_UNSAFE=1).
 *
 * Usage:
 *   E2E_DB_URL_READWRITE='postgres://...' npx tsx e2e/fixtures/reset-tenant-fixtures.ts
 *   npm run qa:reset
 *
 * Flags:
 *   --dry-run    resolve tenants + print the before-counts / table list,
 *                but do not delete anything.
 */
import { Client } from 'pg';
import { checkDatabaseUrlSafety, exitIfUnsafe } from './safety';

interface ResolvedTenant {
  id: string;
  owner_id: string;
}

/** Same owner_id derivation the two seeders use — kept in lockstep here. */
function expectedOwnerIds(): string[] {
  const journeyPrefix = process.env.QA_JOURNEY_SEED_PREFIX ?? 'qa-journey';
  const matrixPrefix = process.env.QA_MATRIX_SEED_PREFIX ?? 'qa-matrix';
  return [
    // e2e/fixtures/seed-journey-fixtures.ts: ownerId = `qa-journey:${slug}`, slug = `${prefix}-A/B`
    `qa-journey:${journeyPrefix}-A`,
    `qa-journey:${journeyPrefix}-B`,
    // e2e/qa-matrix/fixtures/seed.ts: ownerId = `qa:${slug}`, slug = `${prefix}-A/B`
    `qa:${matrixPrefix}-A`,
    `qa:${matrixPrefix}-B`,
  ];
}

function shouldUseSsl(connectionString: string): boolean {
  return /railway|rlwy|supabase|amazonaws|heroku/i.test(connectionString);
}

async function tenantScopedTables(client: Client): Promise<string[]> {
  const res = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
     WHERE column_name = 'tenant_id' AND table_schema = 'public'
     ORDER BY table_name`
  );
  // Defense in depth: 'tenants' itself has no tenant_id column and should
  // never appear here, but exclude it explicitly so a future schema change
  // (e.g. a self-referential tenant_id on `tenants`) can never cause this
  // script to delete tenant rows.
  return res.rows.map((r) => r.table_name).filter((t) => t !== 'tenants');
}

async function countRows(
  client: Client,
  tables: string[],
  tenantIds: string[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const table of tables) {
    const res = await client.query(
      `SELECT count(*)::int AS n FROM "${table}" WHERE tenant_id = ANY($1::uuid[])`,
      [tenantIds]
    );
    counts.set(table, res.rows[0].n);
  }
  return counts;
}

const isDryRun = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  const connectionString = process.env.E2E_DB_URL_READWRITE;
  if (!connectionString) {
    console.error('[qa-reset] Set E2E_DB_URL_READWRITE to the QA service-role connection (see .env.qa).');
    process.exit(1);
  }

  const decision = checkDatabaseUrlSafety(connectionString);
  exitIfUnsafe(decision);

  const ownerIds = expectedOwnerIds();
  console.log('[qa-reset] Known QA tenant owner_ids (closed list, no wildcards):');
  for (const o of ownerIds) console.log(`  - ${o}`);

  const client = new Client({
    connectionString,
    ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  try {
    const res = await client.query<ResolvedTenant>(
      `SELECT id, owner_id FROM tenants WHERE owner_id = ANY($1::text[])`,
      [ownerIds]
    );
    const resolved = res.rows;

    // Hard-fail guard: refuse to proceed if resolution returned anything
    // outside the closed owner_id list we asked for (should be impossible
    // given the WHERE clause above, but this is the last line of defense
    // before any DELETE runs).
    for (const row of resolved) {
      if (!ownerIds.includes(row.owner_id)) {
        console.error(
          `[qa-reset] REFUSED: resolved tenant ${row.id} has owner_id '${row.owner_id}', ` +
            `which is outside the known QA owner_id list. Refusing to touch it.`
        );
        process.exit(2);
      }
    }

    if (resolved.length === 0) {
      console.log(
        '[qa-reset] None of the known QA tenants exist yet (owner_id not found). ' +
          'Nothing to reset — run `npm run qa:setup` to create them.'
      );
      return;
    }

    const tenantIds = resolved.map((r) => r.id);
    console.log(`\n[qa-reset] Resolved ${resolved.length}/${ownerIds.length} known QA tenant(s):`);
    for (const row of resolved) console.log(`  - ${row.owner_id} -> ${row.id}`);
    const missing = ownerIds.filter((o) => !resolved.some((r) => r.owner_id === o));
    if (missing.length > 0) {
      console.log(
        `[qa-reset] Note: ${missing.length} known QA tenant(s) not present (never seeded), skipping: ${missing.join(', ')}`
      );
    }

    const tables = await tenantScopedTables(client);
    console.log(`\n[qa-reset] ${tables.length} tenant-scoped table(s) discovered via information_schema.`);

    console.log('\n[qa-reset] Counting rows BEFORE reset (scoped to the resolved tenant ids only)...');
    const before = await countRows(client, tables, tenantIds);
    const nonZeroBefore = [...before.entries()].filter(([, n]) => n > 0);
    if (nonZeroBefore.length === 0) {
      console.log('[qa-reset] All tenant-scoped tables are already empty for these tenants. Nothing to do.');
      return;
    }
    for (const [table, n] of nonZeroBefore) {
      console.log(`  ${table.padEnd(32)} ${n}`);
    }

    if (isDryRun) {
      console.log('\n[qa-reset] --dry-run — no DELETEs issued.');
      return;
    }

    console.log(
      `\n[qa-reset] Deleting rows scoped to ${tenantIds.length} tenant id(s) from ${tables.length} table(s), in one transaction...`
    );
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL statement_timeout = '120s'`);
      // Transaction-scoped (reverts automatically at COMMIT/ROLLBACK) so we
      // never have to remember to restore it, and per-table DELETEs don't
      // need to be topologically sorted against the FK graph.
      await client.query(`SET LOCAL session_replication_role = 'replica'`);
      for (const table of tables) {
        await client.query(`DELETE FROM "${table}" WHERE tenant_id = ANY($1::uuid[])`, [tenantIds]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error('[qa-reset] FAILED — transaction rolled back, no data was deleted.');
      throw err;
    }
    console.log('[qa-reset] Transaction committed.');

    console.log('\n[qa-reset] Counting rows AFTER reset...');
    const after = await countRows(client, tables, tenantIds);

    console.log('\n[qa-reset] Before -> After (tables with any rows before the reset):');
    let anyLeftover = false;
    for (const [table] of nonZeroBefore) {
      const b = before.get(table) ?? 0;
      const a = after.get(table) ?? 0;
      if (a > 0) anyLeftover = true;
      console.log(`  ${table.padEnd(32)} ${String(b).padStart(6)} -> ${a}`);
    }

    if (anyLeftover) {
      console.error('\n[qa-reset] WARNING: some rows remain after reset for the resolved tenant ids. Investigate before re-seeding.');
      process.exit(1);
    }

    console.log('\n[qa-reset] Clean slate confirmed for all resolved QA tenants. Run `npm run qa:setup` to re-seed.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[qa-reset] failed:', err);
  process.exit(1);
});
