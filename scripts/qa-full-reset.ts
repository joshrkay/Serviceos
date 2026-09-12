/**
 * Reset disposable full-QA fixtures created by seed-full-qa.ts.
 *
 * Deletes ONLY rows owned by tenants with owner_id LIKE 'qa:<prefix>:%'.
 * Refuses production URLs. Requires QA_TARGET_ENV + E2E_DB_ALLOW_UNSAFE for
 * Railway Development databases named "railway".
 *
 * Usage:
 *   QA_TARGET_ENV=development E2E_DB_ALLOW_UNSAFE=1 \
 *     E2E_DB_URL_READWRITE=postgres://... npx tsx scripts/qa-full-reset.ts
 */
import { Client } from 'pg';

const PREFIX = process.env.QA_FULL_SEED_PREFIX ?? 'qa-full';

function assertSafety(connectionString: string): void {
  let host = '';
  let dbName = '';
  try {
    const u = new URL(connectionString);
    host = u.hostname.toLowerCase();
    dbName = u.pathname.replace(/^\//, '').toLowerCase();
  } catch {
    throw new Error('E2E_DB_URL_READWRITE is not a valid URL');
  }
  if (/prod|production|live/.test(`${host} ${dbName}`)) {
    throw new Error(`Refusing reset against production-looking DB (${host}/${dbName})`);
  }
  const target = (process.env.QA_TARGET_ENV ?? '').toLowerCase();
  if (!['development', 'qa', 'dev'].includes(target)) {
    throw new Error('Set QA_TARGET_ENV=development|qa before reset.');
  }
  if (!/test|e2e|qa|ephemeral|ci/.test(dbName) && process.env.E2E_DB_ALLOW_UNSAFE !== '1') {
    throw new Error(
      `DB name '${dbName}' is not an explicit test/qa name. Set E2E_DB_ALLOW_UNSAFE=1 only for Railway Development.`,
    );
  }
  if (process.env.QA_RESET_CONFIRM !== `reset-${PREFIX}`) {
    throw new Error(
      `Refusing reset without QA_RESET_CONFIRM=reset-${PREFIX} (prevents accidents).`,
    );
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.E2E_DB_URL_READWRITE ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('Set E2E_DB_URL_READWRITE');
    process.exit(1);
  }
  assertSafety(connectionString);

  const client = new Client({
    connectionString,
    ssl: /railway|rlwy|supabase|amazonaws/i.test(connectionString)
      ? { rejectUnauthorized: false }
      : undefined,
  });
  await client.connect();

  try {
    const tenants = await client.query(
      `SELECT id, owner_id, name FROM tenants WHERE owner_id LIKE $1`,
      [`qa:${PREFIX}:%`],
    );
    if (tenants.rows.length === 0) {
      console.log(`[qa-full-reset] no tenants matching qa:${PREFIX}:% — nothing to do`);
      return;
    }
    const ids = tenants.rows.map((r) => r.id as string);
    console.log(`[qa-full-reset] deleting ${ids.length} QA tenants and dependent rows…`);
    for (const t of tenants.rows) {
      console.log(`  - ${t.id} (${t.owner_id})`);
    }

    // Best-effort child deletes before tenants (order matters for FKs).
    const childTables = [
      'portal_sessions',
      'appointment_assignments',
      'appointments',
      'estimate_line_items',
      'estimates',
      'invoice_line_items',
      'payments',
      'invoices',
      'job_timeline_events',
      'jobs',
      'service_locations',
      'leads',
      'notes',
      'proposals',
      'conversations',
      'messages',
      'interactions',
      'audit_events',
      'users',
      'tenant_settings',
      'tenant_integrations',
      'customers',
    ];

    await client.query('BEGIN');
    for (const table of childTables) {
      try {
        const res = await client.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [
          ids,
        ]);
        console.log(`  deleted ${res.rowCount ?? 0} from ${table}`);
      } catch (err) {
        console.warn(`  skip ${table}: ${(err as Error).message}`);
      }
    }
    const delTenants = await client.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [ids]);
    console.log(`  deleted ${delTenants.rowCount ?? 0} tenants`);
    await client.query('COMMIT');
    console.log('[qa-full-reset] done. Re-run npm run qa:full:seed to recreate fixtures.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[qa-full-reset] failed:', err);
  process.exit(1);
});
