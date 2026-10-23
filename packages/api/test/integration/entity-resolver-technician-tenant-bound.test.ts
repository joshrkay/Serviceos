/**
 * Postgres integration — the entity resolver's technician-name join never
 * reads another tenant's `users` row.
 *
 * Four appointment lookups in `PgEntityResolver` (clock time, job-anchored,
 * customer-anchored, and the multi-job fan-out) LEFT JOIN the primary
 * assignment's technician so a picker can say WHO: `LEFT JOIN users u ON
 * u.id = aa.technician_id`. `appointment_assignments.technician_id` only
 * references `users(id)` — nothing ties that user to the assignment's tenant
 * — and the join had no tenant predicate, so a technician id that points at
 * another tenant's user read that user's name into this tenant's candidate
 * hint. Under `RLS_RUNTIME_ROLE=true` the `users` policy hides the row; with
 * the policy inert (flag unset) the join itself was the only bound and there
 * was none. The join now carries `AND u.tenant_id = aa.tenant_id`.
 *
 * Each site is driven through the production `resolve()` entry point, with
 * the flag on and off, for the tenant's own technician (still named) and for
 * a cross-tenant technician id (never named). The cross-tenant row is seeded
 * through the superuser pool on purpose: it is the corrupt state the
 * predicate defends against, which the app's own assign path refuses to write.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DateTime } from 'luxon';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import type { EntityResolverResult } from '../../src/ai/resolution/entity-resolver';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const TZ = 'Pacific/Honolulu';
const FOREIGN_TECH = { first: 'Xavierforeign', last: 'Otherco' };
const OWN_TECH = { first: 'Carlos', last: 'Vega' };

let pool: Pool;
let resolver: PgEntityResolver;
const createdTenantIds: string[] = [];

interface Shop {
  tenantId: string;
  userId: string;
  customerId: string;
  locationId: string;
}

async function seedShop(customerName: string): Promise<Shop> {
  const { tenantId, userId } = await createTestTenant(pool);
  createdTenantIds.push(tenantId);
  await pool.query(
    `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region)
     VALUES (gen_random_uuid(), $1, 'Bound Shop', $2, 'HI')`,
    [tenantId, TZ],
  );
  const [firstName, ...rest] = customerName.split(' ');
  const { rows: c } = await pool.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, first_name, last_name, display_name, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [tenantId, firstName, rest.join(' '), customerName, userId],
  );
  const { rows: l } = await pool.query<{ id: string }>(
    `INSERT INTO service_locations (tenant_id, customer_id, street1, city, state, postal_code)
     VALUES ($1, $2, '1 Bound St', 'Honolulu', 'HI', '96813') RETURNING id`,
    [tenantId, c[0].id],
  );
  return { tenantId, userId, customerId: c[0].id, locationId: l[0].id };
}

async function seedJob(shop: Shop, summary: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO jobs (tenant_id, customer_id, location_id, job_number, summary, status, created_by)
     VALUES ($1, $2, $3, $4, $5, 'scheduled', $6) RETURNING id`,
    [shop.tenantId, shop.customerId, shop.locationId, `JOB-${crypto.randomUUID().slice(0, 8)}`, summary, shop.userId],
  );
  return rows[0].id;
}

async function seedTechnician(tenantId: string, name: { first: string; last: string }): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name)
     VALUES ($1, $2, $3, $4, 'technician', $5, $6)`,
    [id, tenantId, `clerk-${id}`, `tech.${id.slice(0, 8)}@example.com`, name.first, name.last],
  );
  return id;
}

/** An appointment on `jobId` with a primary assignment to `technicianId`. */
async function seedAssignedAppointment(shop: Shop, jobId: string, start: Date, technicianId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO appointments (tenant_id, job_id, scheduled_start, scheduled_end, timezone, status, created_by)
     VALUES ($1, $2, $3, $4, $5, 'scheduled', $6) RETURNING id`,
    [shop.tenantId, jobId, start, new Date(start.getTime() + 60 * 60 * 1000), TZ, shop.userId],
  );
  await pool.query(
    `INSERT INTO appointment_assignments (tenant_id, appointment_id, technician_id, is_primary, assigned_by)
     VALUES ($1, $2, $3, true, $4)`,
    [shop.tenantId, rows[0].id, technicianId, shop.userId],
  );
  return rows[0].id;
}

function daysOut(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/** Today's 2pm in TZ if still ahead, else tomorrow's — what a bare "the 2pm" means. */
function nextLocalTwoPmUtc(): Date {
  const at = (dayOffset: number) =>
    DateTime.now().setZone(TZ).plus({ days: dayOffset })
      .set({ hour: 14, minute: 0, second: 0, millisecond: 0 }).toUTC().toJSDate();
  const today = at(0);
  return today.getTime() > Date.now() ? today : at(1);
}

function resolvedHint(result: EntityResolverResult, appointmentId: string): string | undefined {
  expect(result.kind).toBe('resolved');
  if (result.kind !== 'resolved') return undefined;
  expect(result.candidate.id).toBe(appointmentId);
  return result.candidate.hint;
}

interface Site {
  name: string;
  /** Seeds one assigned appointment for `technicianId` and resolves it. */
  run: (technicianFor: (shop: Shop) => Promise<string>) => Promise<{ hint: string | undefined }>;
  ownHint: string;
  foreignHint: string;
}

const SITES: Site[] = [
  {
    name: 'clock-time reference ("the 2pm")',
    ownHint: `Bound clock repair · assigned to ${OWN_TECH.first} ${OWN_TECH.last}`,
    foreignHint: 'Bound clock repair',
    run: async (technicianFor) => {
      const shop = await seedShop('Kealoha Clock');
      const jobId = await seedJob(shop, 'Bound clock repair');
      const appointmentId = await seedAssignedAppointment(shop, jobId, nextLocalTwoPmUtc(), await technicianFor(shop));
      const result = await resolver.resolve({ tenantId: shop.tenantId, reference: 'the 2pm', kind: 'appointment' });
      return { hint: resolvedHint(result, appointmentId) };
    },
  },
  {
    name: 'job-anchored lookup',
    ownHint: `assigned to ${OWN_TECH.first} ${OWN_TECH.last}`,
    foreignHint: 'unassigned',
    run: async (technicianFor) => {
      const shop = await seedShop('Kealoha Anchor');
      const jobId = await seedJob(shop, 'Bound job repair');
      const appointmentId = await seedAssignedAppointment(shop, jobId, daysOut(3), await technicianFor(shop));
      // A non-empty reference with no day or clock phrase: the job anchor scopes it.
      const result = await resolver.resolve({ tenantId: shop.tenantId, reference: 'the appointment', kind: 'appointment', jobId });
      return { hint: resolvedHint(result, appointmentId) };
    },
  },
  {
    name: 'customer-anchored lookup',
    ownHint: `assigned to ${OWN_TECH.first} ${OWN_TECH.last}`,
    foreignHint: 'scheduled',
    run: async (technicianFor) => {
      const shop = await seedShop('Kealoha Person');
      const jobId = await seedJob(shop, 'Bound customer repair');
      const appointmentId = await seedAssignedAppointment(shop, jobId, daysOut(3), await technicianFor(shop));
      const result = await resolver.resolve({
        tenantId: shop.tenantId,
        reference: '',
        kind: 'appointment',
        customerId: shop.customerId,
      });
      return { hint: resolvedHint(result, appointmentId) };
    },
  },
  {
    name: 'named reference fanned out over several jobs',
    ownHint: `assigned to ${OWN_TECH.first} ${OWN_TECH.last}`,
    foreignHint: 'unassigned',
    run: async (technicianFor) => {
      // Two jobs carry the customer's name, so the job match is ambiguous and
      // the resolver fans out to those jobs' appointments; only one has one.
      const shop = await seedShop('Quentin Zylstrom');
      const jobWithVisit = await seedJob(shop, 'AC repair');
      await seedJob(shop, 'Furnace tune-up');
      const appointmentId = await seedAssignedAppointment(shop, jobWithVisit, daysOut(4), await technicianFor(shop));
      const result = await resolver.resolve({
        tenantId: shop.tenantId,
        reference: "Zylstrom's appointment",
        kind: 'appointment',
      });
      return { hint: resolvedHint(result, appointmentId) };
    },
  },
];

beforeAll(async () => {
  pool = await getSharedTestDb();
  resolver = new PgEntityResolver(pool);
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

afterAll(async () => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
  for (const tenantId of createdTenantIds) {
    for (const table of ['appointment_assignments', 'appointments', 'jobs', 'service_locations', 'customers', 'tenant_settings']) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]).catch(() => undefined);
    }
  }
  for (const tenantId of createdTenantIds) {
    await pool.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('PgEntityResolver technician join — tenant-bounded (real Postgres)', () => {
  for (const flag of ['true', undefined] as const) {
    const label = flag ? 'RLS_RUNTIME_ROLE=true' : 'RLS_RUNTIME_ROLE unset (policy inert)';

    for (const site of SITES) {
      it(`${label} · ${site.name}: the tenant's own technician is still named`, async () => {
        if (flag) process.env.RLS_RUNTIME_ROLE = flag;
        else delete process.env.RLS_RUNTIME_ROLE;

        const { hint } = await site.run((shop) => seedTechnician(shop.tenantId, OWN_TECH));
        expect(hint).toBe(site.ownHint);
      });

      it(`${label} · ${site.name}: a technician id pointing at another tenant's user is never named`, async () => {
        if (flag) process.env.RLS_RUNTIME_ROLE = flag;
        else delete process.env.RLS_RUNTIME_ROLE;

        const { tenantId: otherTenantId } = await createTestTenant(pool);
        createdTenantIds.push(otherTenantId);
        const foreignTechId = await seedTechnician(otherTenantId, FOREIGN_TECH);

        const { hint } = await site.run(async () => foreignTechId);
        expect(hint).not.toContain(FOREIGN_TECH.first);
        expect(hint).toBe(site.foreignHint);
      });
    }
  }
});
