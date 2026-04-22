/**
 * One-time seeder for the QA matrix tenants.
 *
 * Run against Railway dev DB BEFORE the matrix:
 *   tsx e2e/qa-matrix/fixtures/seed.ts
 *
 * Emits the env-var lines tokens.ts expects (tenant / customer / job ids)
 * so you can paste them into your shell before running the matrix.
 *
 * Seeds two tenants (A and B) with one customer + one open job each.
 * Idempotent: re-running with the same QA_MATRIX_SEED_PREFIX re-uses
 * existing rows. Uses the service role connection string via
 * E2E_DB_URL_READWRITE (distinct from the read-only one Agent C uses).
 */

import { Client } from 'pg';
import { randomUUID } from 'node:crypto';

async function main() {
  const connectionString = process.env.E2E_DB_URL_READWRITE;
  if (!connectionString) {
    console.error('Set E2E_DB_URL_READWRITE to a service-role connection.');
    process.exit(1);
  }

  const prefix = process.env.QA_MATRIX_SEED_PREFIX ?? 'qa-matrix';
  const client = new Client({ connectionString });
  await client.connect();

  try {
    const result = {
      tenantA: await ensureTenantFixture(client, `${prefix}-A`),
      tenantB: await ensureTenantFixture(client, `${prefix}-B`),
    };

    console.log('\n# Paste into your shell before running npm run e2e:qa-matrix:\n');
    console.log(`export E2E_TENANT_A_ID=${result.tenantA.tenantId}`);
    console.log(`export E2E_TENANT_A_CUSTOMER_ID=${result.tenantA.customerId}`);
    console.log(`export E2E_TENANT_A_JOB_ID=${result.tenantA.jobId}`);
    console.log(`export E2E_TENANT_B_ID=${result.tenantB.tenantId}`);
    console.log(`export E2E_TENANT_B_CUSTOMER_ID=${result.tenantB.customerId}`);
    console.log(`export E2E_TENANT_B_JOB_ID=${result.tenantB.jobId}`);
    console.log('\n# Clerk test tokens must be exported separately (see qa/README.md).');
  } finally {
    await client.end();
  }
}

interface Fixture {
  tenantId: string;
  customerId: string;
  jobId: string;
}

async function ensureTenantFixture(client: Client, slug: string): Promise<Fixture> {
  const existing = await client.query(
    `SELECT id FROM tenants WHERE slug = $1 LIMIT 1`,
    [slug]
  );
  const tenantId =
    existing.rows[0]?.id ??
    (await client
      .query(
        `INSERT INTO tenants (id, slug, name, created_at, updated_at)
         VALUES ($1, $2, $3, now(), now())
         RETURNING id`,
        [randomUUID(), slug, `QA Matrix ${slug}`]
      )
      .then((r) => r.rows[0].id));

  const customerRes = await client.query(
    `SELECT id FROM customers WHERE tenant_id = $1 AND name = $2 LIMIT 1`,
    [tenantId, `${slug}-customer`]
  );
  const customerId =
    customerRes.rows[0]?.id ??
    (await client
      .query(
        `INSERT INTO customers (id, tenant_id, name, created_at, updated_at)
         VALUES ($1, $2, $3, now(), now())
         RETURNING id`,
        [randomUUID(), tenantId, `${slug}-customer`]
      )
      .then((r) => r.rows[0].id));

  const jobRes = await client.query(
    `SELECT id FROM jobs WHERE tenant_id = $1 AND title = $2 LIMIT 1`,
    [tenantId, `${slug}-job`]
  );
  const jobId =
    jobRes.rows[0]?.id ??
    (await client
      .query(
        `INSERT INTO jobs (id, tenant_id, customer_id, title, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'open', now(), now())
         RETURNING id`,
        [randomUUID(), tenantId, customerId, `${slug}-job`]
      )
      .then((r) => r.rows[0].id));

  return { tenantId, customerId, jobId };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
