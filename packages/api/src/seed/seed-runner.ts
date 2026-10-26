/**
 * Inserts a {@link SeedPlan} into a real database via the production Pg
 * repositories — the same create paths the API routes use, so seeded rows pass
 * every validation, RLS policy, and generated column exactly as live data does.
 *
 * Per tenant: a `tenants` row + an owner `users` row, then for each planned
 * customer a customer → service location → job → estimate → appointment chain.
 * Defaults (10 tenants × 20) produce 200 customers, 200 estimates, and 200
 * appointments, each appointment on its own day/time (see seed-plan.ts).
 */
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { withTenantSession } from '../db/rls-runtime-role';
import { PgTenantRepository } from '../auth/pg-tenant';
import { PgCustomerRepository } from '../customers/pg-customer';
import { PgLocationRepository } from '../locations/pg-location';
import { PgJobRepository } from '../jobs/pg-job';
import { PgEstimateRepository } from '../estimates/pg-estimate';
import { PgAppointmentRepository } from '../appointments/pg-appointment';
import { createCustomer } from '../customers/customer';
import { createLocation } from '../locations/location';
import { createJob } from '../jobs/job';
import { createEstimate } from '../estimates/estimate';
import { createAppointment } from '../appointments/appointment';
import { buildLineItem } from '../shared/billing-engine';
import { generateSeedPlan, type SeedPlanOptions, type PlannedTenant } from './seed-plan';

export interface SeedResult {
  tenantIds: string[];
  customers: number;
  estimates: number;
  appointments: number;
}

/**
 * Insert the owner user. There is no PgUserRepository.create, so this is the
 * one raw insert: a tenant session of its own (BEGIN, the tenant GUC and the
 * RLS runtime role, both transaction-local, COMMIT), so the users policy's
 * WITH CHECK binds the VALUES tenant.
 */
async function insertOwnerUser(
  pool: Pool,
  tenantId: string,
  clerkUserId: string,
  email: string,
): Promise<string> {
  const userId = uuidv4();
  await withTenantSession(pool, tenantId, (client) =>
    client.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name)
       VALUES ($1, $2, $3, $4, 'owner', 'Seed', 'Owner')`,
      [userId, tenantId, clerkUserId, email],
    ),
  );
  return userId;
}

async function seedTenant(
  pool: Pool,
  repos: {
    tenantRepo: PgTenantRepository;
    customerRepo: PgCustomerRepository;
    locationRepo: PgLocationRepository;
    jobRepo: PgJobRepository;
    estimateRepo: PgEstimateRepository;
    appointmentRepo: PgAppointmentRepository;
  },
  pt: PlannedTenant,
  result: SeedResult,
): Promise<void> {
  const ownerEmail = `owner@${pt.slug}.example.com`;
  // owner_id is UNIQUE on tenants — a fresh uuid per run keeps reseeds clean.
  const clerkUserId = `seed-owner-${uuidv4()}`;
  const tenant = await repos.tenantRepo.create({
    ownerId: clerkUserId,
    ownerEmail,
    name: pt.businessName,
  });
  result.tenantIds.push(tenant.id);
  const ownerUserId = await insertOwnerUser(pool, tenant.id, clerkUserId, ownerEmail);

  for (const e of pt.entities) {
    const customer = await createCustomer(
      {
        tenantId: tenant.id,
        firstName: e.customer.firstName,
        lastName: e.customer.lastName,
        primaryPhone: e.customer.primaryPhone,
        email: e.customer.email,
        createdBy: ownerUserId,
      },
      repos.customerRepo,
    );
    result.customers++;

    const location = await createLocation(
      {
        tenantId: tenant.id,
        customerId: customer.id,
        street1: e.location.street1,
        city: e.location.city,
        state: e.location.state,
        postalCode: e.location.postalCode,
      },
      repos.locationRepo,
      undefined,
      ownerUserId,
    );

    const job = await createJob(
      {
        tenantId: tenant.id,
        customerId: customer.id,
        locationId: location.id,
        summary: e.jobSummary,
        createdBy: ownerUserId,
      },
      repos.jobRepo,
    );

    const lineItems = e.estimate.lineItems.map((li, i) =>
      buildLineItem(uuidv4(), li.description, li.quantity, li.unitPriceCents, i, true, li.category),
    );
    await createEstimate(
      {
        tenantId: tenant.id,
        jobId: job.id,
        estimateNumber: e.estimate.estimateNumber,
        lineItems,
        taxRateBps: e.estimate.taxRateBps,
        createdBy: ownerUserId,
      },
      repos.estimateRepo,
    );
    result.estimates++;

    await createAppointment(
      {
        tenantId: tenant.id,
        jobId: job.id,
        scheduledStart: e.appointment.scheduledStart,
        scheduledEnd: e.appointment.scheduledEnd,
        timezone: e.appointment.timezone,
        createdBy: ownerUserId,
      },
      repos.appointmentRepo,
    );
    result.appointments++;
  }
}

/** Email pattern stamped on every seeded tenant's owner — the marker
 *  `cleanSeed` uses to find (only) demo tenants to remove. */
const SEED_OWNER_EMAIL_LIKE = 'owner@seed-tenant-%';

/** FK order: leaves → root. audit_events is defensive (the seeder writes none,
 *  but a full tenant teardown should leave nothing referencing the tenant). */
const SEED_CHILD_TABLES = [
  'appointments',
  'estimates',
  'jobs',
  'service_locations',
  'customers',
  'audit_events',
  'users',
] as const;

/**
 * Remove every tenant this seeder created (identified by its owner_email
 * marker), child rows first so the tenant delete can't trip a foreign key.
 * Real tenants are never matched.
 *
 * Each tenant is one transaction: its child rows and its registry row go
 * together or not at all. The child DELETEs run in a tenant session (the
 * tenant GUC and the RLS runtime role, transaction-local), so the policies
 * bind them. `tenants` is the registry (no tenant_id, no RLS), so the role
 * adds nothing there: the session drops back to the connection principal
 * for that last DELETE (SET LOCAL ROLE NONE, ended by the COMMIT like the
 * role itself), which is how the registry row has always been deleted.
 */
export async function cleanSeed(
  pool: Pool,
  log: (line: string) => void = () => undefined,
): Promise<{ tenantsRemoved: number }> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM tenants WHERE owner_email LIKE $1',
    [SEED_OWNER_EMAIL_LIKE],
  );
  const tenantIds = rows.map((r) => r.id);
  if (tenantIds.length === 0) {
    log('No seeded tenants found.');
    return { tenantsRemoved: 0 };
  }
  for (const tenantId of tenantIds) {
    await withTenantSession(pool, tenantId, async (client) => {
      for (const table of SEED_CHILD_TABLES) {
        await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
      }
      await client.query('SET LOCAL ROLE NONE');
      await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    });
    log(`  removed tenant ${tenantId}`);
  }
  return { tenantsRemoved: tenantIds.length };
}

export async function runSeed(
  pool: Pool,
  options: SeedPlanOptions = {},
  log: (line: string) => void = () => undefined,
): Promise<SeedResult> {
  const plan = generateSeedPlan(options);
  const repos = {
    tenantRepo: new PgTenantRepository(pool),
    customerRepo: new PgCustomerRepository(pool),
    locationRepo: new PgLocationRepository(pool),
    jobRepo: new PgJobRepository(pool),
    estimateRepo: new PgEstimateRepository(pool),
    appointmentRepo: new PgAppointmentRepository(pool),
  };

  const result: SeedResult = { tenantIds: [], customers: 0, estimates: 0, appointments: 0 };
  log(
    `Seeding ${plan.totals.tenants} tenants × ${plan.options.customersPerTenant} ` +
      `→ ${plan.totals.customers} customers / ${plan.totals.estimates} estimates / ` +
      `${plan.totals.appointments} appointments…`,
  );
  for (const pt of plan.tenants) {
    await seedTenant(pool, repos, pt, result);
    log(`  ${pt.businessName} → ${pt.entities.length} customers/estimates/appointments`);
  }
  return result;
}
