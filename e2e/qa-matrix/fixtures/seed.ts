/**
 * One-time seeder for the QA matrix tenants.
 *
 * Run against Railway dev DB BEFORE the matrix:
 *   E2E_DB_URL_READWRITE='postgres://...' npx tsx e2e/qa-matrix/fixtures/seed.ts
 *
 * Emits the env-var lines tokens.ts expects (tenant / customer / job ids)
 * so you can paste them into your shell before running the matrix.
 *
 * Seeds two tenants (A and B) with one customer + one service location +
 * one open job each. Idempotent on QA_MATRIX_SEED_PREFIX — re-runnable.
 * Uses the service-role connection via E2E_DB_URL_READWRITE (distinct from
 * the read-only one Agent C uses).
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
  // Tenants are identified by owner_id (UNIQUE, TEXT). We use a synthetic
  // owner_id derived from the slug so re-runs are idempotent.
  const ownerId = `qa:${slug}`;
  const ownerEmail = `${slug}@qa.serviceos.local`;
  const systemUser = `qa-matrix-seeder`;

  const existingTenant = await client.query(
    `SELECT id FROM tenants WHERE owner_id = $1 LIMIT 1`,
    [ownerId]
  );
  const tenantId =
    existingTenant.rows[0]?.id ??
    (await client
      .query(
        `INSERT INTO tenants (id, owner_id, owner_email, name, created_at, updated_at)
         VALUES ($1, $2, $3, $4, now(), now())
         RETURNING id`,
        [randomUUID(), ownerId, ownerEmail, `QA Matrix ${slug}`]
      )
      .then((r) => r.rows[0].id));

  // Customer: display_name is the idempotency handle here.
  const customerDisplay = `${slug}-customer`;
  const existingCustomer = await client.query(
    `SELECT id FROM customers WHERE tenant_id = $1 AND display_name = $2 LIMIT 1`,
    [tenantId, customerDisplay]
  );
  const customerId =
    existingCustomer.rows[0]?.id ??
    (await client
      .query(
        `INSERT INTO customers
           (id, tenant_id, first_name, last_name, display_name, primary_phone, preferred_channel,
            sms_consent, is_archived, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'none', false, false, $7, now(), now())
         RETURNING id`,
        [randomUUID(), tenantId, 'QA', slug, customerDisplay, '555-0100', systemUser]
      )
      .then((r) => r.rows[0].id));

  // Service location (jobs require a location_id).
  const locationLabel = `${slug}-location`;
  const existingLocation = await client.query(
    `SELECT id FROM service_locations WHERE tenant_id = $1 AND customer_id = $2 AND label = $3 LIMIT 1`,
    [tenantId, customerId, locationLabel]
  );
  const locationId =
    existingLocation.rows[0]?.id ??
    (await client
      .query(
        `INSERT INTO service_locations
           (id, tenant_id, customer_id, label, street1, city, state, postal_code, country, created_at, updated_at)
         VALUES ($1, $2, $3, $4, '1 QA Way', 'Testville', 'CA', '90001', 'US', now(), now())
         RETURNING id`,
        [randomUUID(), tenantId, customerId, locationLabel]
      )
      .then((r) => r.rows[0].id));

  // Job: unique by (tenant_id, job_number).
  const jobNumber = `${slug}-job-1`;
  const existingJob = await client.query(
    `SELECT id FROM jobs WHERE tenant_id = $1 AND job_number = $2 LIMIT 1`,
    [tenantId, jobNumber]
  );
  const jobId =
    existingJob.rows[0]?.id ??
    (await client
      .query(
        `INSERT INTO jobs
           (id, tenant_id, customer_id, location_id, job_number, summary, status, priority, created_by,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'new', 'normal', $7, now(), now())
         RETURNING id`,
        [randomUUID(), tenantId, customerId, locationId, jobNumber, `QA Matrix job for ${slug}`, systemUser]
      )
      .then((r) => r.rows[0].id));

  return { tenantId, customerId, jobId };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
