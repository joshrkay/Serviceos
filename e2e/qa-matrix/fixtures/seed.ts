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
 * one open job + one technician user each. Idempotent on
 * QA_MATRIX_SEED_PREFIX — re-runnable.
 * Uses the service-role connection via E2E_DB_URL_READWRITE (distinct from
 * the read-only one Agent C uses).
 */

import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { PgSeatUsageReader, assertSeatAvailable } from '../../../packages/api/src/users/seat-limit';

/**
 * Shared phone for the ambiguous-match pair seeded per tenant below (VOX-13).
 * Must stay distinct from the primary customer's '555-0100' so that number
 * keeps resolving to exactly one customer for SCH-02/SMS-01's callerPhone.
 */
const AMBIGUOUS_PHONE = '555-0200';

async function main() {
  const connectionString = process.env.E2E_DB_URL_READWRITE;
  if (!connectionString) {
    console.error('Set E2E_DB_URL_READWRITE to a service-role connection.');
    process.exit(1);
  }

  const prefix = process.env.QA_MATRIX_SEED_PREFIX ?? 'qa-matrix';
  const client = new Pool({ connectionString, max: 2 });

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
    console.log(`export E2E_TENANT_A_TECHNICIAN_USER_ID=${result.tenantA.technicianUserId}`);
    console.log(`export E2E_TENANT_B_TECHNICIAN_USER_ID=${result.tenantB.technicianUserId}`);
    console.log('\n# Clerk test tokens must be exported separately (see qa/README.md).');
  } finally {
    await client.end();
  }
}

export interface Fixture {
  tenantId: string;
  customerId: string;
  jobId: string;
  /** #1401 — the tenant's seeded technician (users.id), for §3 conflict/reassign rows. */
  technicianUserId: string;
}

/**
 * The plan the matrix tenants are seeded on. Seats are granted by plan
 * (packages/api/src/users/seat-limit.ts — Starter 2 users, Growth 5, every
 * non-deleted user and open invitation counts). The matrix tenants carry
 * ~4 QA logins (seed owner + scripts/ensure-qa-hmac-users.ts runbook /
 * doctor-probe subjects) plus the technician below, which only Growth
 * covers. We grant the seats the product way — by plan — never by skipping
 * the limit.
 */
const MATRIX_PLAN_ID = 'growth';

export async function ensureTenantFixture(client: Pool, slug: string): Promise<Fixture> {
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

  // QA identity — a `users` row for the HMAC-minted token's `sub` claim.
  // Required since QUALITY-2026-07-12 WS4 added DB-authoritative authorization
  // (packages/api/src/auth/authorization-loader.ts): a validly-signed JWT with
  // a tenant_id claim is no longer sufficient by itself — the API requires a
  // matching `users` row (tenant_id, clerk_user_id) with status='active', or
  // every authenticated request 403s "No active membership for this tenant".
  // e2e/qa-matrix/fixtures/tokens.ts mints `qa-matrix-user-${label}`; label is
  // the slug's trailing A/B (e.g. "qa-matrix-A" -> "A").
  const qaUserLabel = slug.slice(-1);
  await client.query(
    `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'owner', 'active', now(), now())
     ON CONFLICT (tenant_id, clerk_user_id) DO NOTHING`,
    [randomUUID(), tenantId, `qa-matrix-user-${qaUserLabel}`, `${slug}-matrix-owner@qa.serviceos.local`]
  );

  // Customer: display_name is the idempotency handle here.
  //
  // QA-2026-07-26 — sms_consent MUST be true for this primary customer.
  // SMS-01 drives the voice booking with callerPhone='555-0100', so
  // InAppVoiceAdapter resolves the caller to THIS row, and placeAppointmentHold's
  // ownership guard (packages/api/src/ai/scheduling/place-hold.ts) rejects any
  // job whose customerId !== the resolved caller — pinning the booked
  // appointment to this customer's job. The confirmation SMS is therefore
  // necessarily addressed to this customer; with sms_consent=false the consent
  // gate suppresses it and returns before recordDispatch(), so zero rows land in
  // message_dispatches and SMS-01 can never pass. The negative case (SMS-02)
  // does not depend on this row — it creates its own non-consenting customer
  // via chain(h, false, '02'). The ambiguous pair below stays non-consenting;
  // its consent is irrelevant to what it tests.
  //
  // QA-2026-07-26 — email MUST be set on this primary customer. VOX-06 speaks
  // "send estimate <number> to the customer by email"; the estimate is seeded
  // against h.tenantA.jobId, which is THIS customer's job, so SendService
  // resolves the recipient from this row. resolveTargets()
  // (packages/api/src/notifications/send-service.ts) throws
  // "Cannot send email — no email provided and customer has no email on file"
  // when customers.email is NULL, and it throws BEFORE the status:'sent' write
  // — so the proposal lands in execution_failed and the estimate stays 'draft',
  // failing VOX-06 for a fixture reason rather than a product one. The address
  // is deliberately non-routable (.local is reserved by RFC 6762 and never
  // resolves publicly); non-prod is also structurally incapable of real
  // delivery (b7e3a8e9), so this is belt-and-braces. Do NOT add an email to the
  // ambiguous pair below — VOX-12/VOX-13 test phone ambiguity and need neither.
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
           (id, tenant_id, first_name, last_name, display_name, primary_phone, email,
            preferred_channel, sms_consent, is_archived, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'none', true, false, $8, now(), now())
         RETURNING id`,
        [
          randomUUID(),
          tenantId,
          'QA',
          slug,
          customerDisplay,
          '555-0100',
          `${customerDisplay}@qa.serviceos.local`,
          systemUser,
        ]
      )
      .then((r) => r.rows[0].id));

  // Ambiguous-phone pair (VOX-13): two customers on the SAME tenant sharing
  // one phone number, distinct from the primary customer's '555-0100' above
  // (that number must stay a single match for SCH-02/SMS-01's callerPhone
  // resolution). Exercises the "0 or 2+ matches are left unresolved" branch
  // of InAppVoiceAdapter.startSession — the adapter must never guess between
  // them. display_name is the idempotency handle, same pattern as above.
  for (const suffix of ['ambiguous-1', 'ambiguous-2']) {
    const display = `${slug}-${suffix}`;
    const existingAmbiguous = await client.query(
      `SELECT id FROM customers WHERE tenant_id = $1 AND display_name = $2 LIMIT 1`,
      [tenantId, display]
    );
    if (!existingAmbiguous.rows[0]) {
      await client.query(
        `INSERT INTO customers
           (id, tenant_id, first_name, last_name, display_name, primary_phone, preferred_channel,
            sms_consent, is_archived, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'none', false, false, $7, now(), now())`,
        [randomUUID(), tenantId, 'QA', suffix, display, AMBIGUOUS_PHONE, systemUser]
      );
    }
  }

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

  const technicianUserId = await ensureTechnicianUser(client, tenantId, slug);

  return { tenantId, customerId, jobId, technicianUserId };
}

/**
 * #1401 — one technician login per matrix tenant, so §3 conflict detection
 * and reassign have someone to assign to. Idempotent on clerk_user_id. The
 * tenant is moved onto MATRIX_PLAN_ID first (only ever upgrading a Starter /
 * unset plan); the insert then goes through the product's own seat check
 * (PgSeatUsageReader + assertSeatAvailable), so a tenant whose seats are
 * genuinely full makes the seed fail with SEAT_LIMIT_REACHED instead of
 * quietly seating a user past the limit.
 */
async function ensureTechnicianUser(client: Pool, tenantId: string, slug: string): Promise<string> {
  const label = slug.slice(-1);
  const clerkUserId = `qa-matrix-tech-${label}`;

  const existing = await client.query(
    `SELECT id FROM users WHERE tenant_id = $1 AND clerk_user_id = $2 LIMIT 1`,
    [tenantId, clerkUserId]
  );
  if (existing.rows[0]) return existing.rows[0].id as string;

  await client.query(
    `UPDATE tenants SET plan_id = $2, updated_at = now()
      WHERE id = $1 AND (plan_id IS NULL OR plan_id = 'starter')`,
    [tenantId, MATRIX_PLAN_ID]
  );
  assertSeatAvailable(await new PgSeatUsageReader(client).getSeatUsage(tenantId));

  const inserted = await client.query(
    `INSERT INTO users
       (id, tenant_id, clerk_user_id, email, role, first_name, last_name, status,
        can_field_serve, current_mode, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'technician', 'QA', $5, 'active', true, 'tech', now(), now())
     ON CONFLICT (tenant_id, clerk_user_id) DO NOTHING
     RETURNING id`,
    [randomUUID(), tenantId, clerkUserId, `${slug}-technician@qa.serviceos.local`, `Tech ${label}`]
  );
  if (inserted.rows[0]) return inserted.rows[0].id as string;
  // Lost a race with a concurrent seeder — read the winner's row.
  const winner = await client.query(
    `SELECT id FROM users WHERE tenant_id = $1 AND clerk_user_id = $2 LIMIT 1`,
    [tenantId, clerkUserId]
  );
  return winner.rows[0].id as string;
}

// Run only when executed directly (`npx tsx e2e/qa-matrix/fixtures/seed.ts`),
// not when imported (the #1401 integration test imports ensureTenantFixture).
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
