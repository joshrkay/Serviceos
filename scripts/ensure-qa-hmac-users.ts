/**
 * Idempotent: ensure synthetic HMAC JWT subjects have users rows in dev Postgres.
 * Required for qa:doctor HMAC probe and qa-matrix / qa-runbook tokens.
 *
 * Usage:
 *   source scripts/load-dev-env.sh
 *   npx tsx scripts/ensure-qa-hmac-users.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

interface Row {
  clerkUserId: string;
  tenantId: string;
  email: string;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}. Run: source scripts/load-dev-env.sh`);
  return v;
}

async function ensureRow(client: Client, row: Row): Promise<'inserted' | 'exists'> {
  const existing = await client.query(
    `SELECT id FROM users WHERE tenant_id = $1 AND clerk_user_id = $2 LIMIT 1`,
    [row.tenantId, row.clerkUserId],
  );
  if ((existing.rowCount ?? 0) > 0) return 'exists';

  await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [row.tenantId]);
  await client.query(
    `INSERT INTO users (
       id, tenant_id, clerk_user_id, email, role, can_field_serve, current_mode, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'owner', true, 'supervisor', now(), now())`,
    [randomUUID(), row.tenantId, row.clerkUserId, row.email],
  );
  return 'inserted';
}

async function main(): Promise<void> {
  const tenantA = requireEnv('E2E_TENANT_A_ID');
  const tenantB = requireEnv('E2E_TENANT_B_ID');
  const dbUrl = process.env.E2E_DB_URL_READWRITE ?? process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('Missing E2E_DB_URL_READWRITE or DATABASE_URL');

  const rows: Row[] = [
    { clerkUserId: 'qa-matrix-user-A', tenantId: tenantA, email: 'qa-matrix-A@qa.serviceos.local' },
    { clerkUserId: 'qa-matrix-user-B', tenantId: tenantB, email: 'qa-matrix-B@qa.serviceos.local' },
    { clerkUserId: 'qa-runbook-user-A', tenantId: tenantA, email: 'runbook-A@qa.serviceos.local' },
    { clerkUserId: 'qa-runbook-user-B', tenantId: tenantB, email: 'runbook-B@qa.serviceos.local' },
    { clerkUserId: 'qa-runbook-user-doctor-probe', tenantId: tenantA, email: 'doctor-probe@qa.serviceos.local' },
  ];

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    for (const row of rows) {
      const result = await ensureRow(client, row);
      process.stdout.write(`${result}: ${row.clerkUserId} @ ${row.tenantId.slice(0, 8)}…\n`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
