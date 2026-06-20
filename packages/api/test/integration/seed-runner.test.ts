/**
 * Postgres integration — the demo seeder writes a real, MULTI-TENANT, isolated,
 * day-distinct dataset. Proves runSeed inserts the full customer → location →
 * job → estimate → appointment chain through the production repositories (so
 * every row passes validation), that each tenant's data is fully SEPARATED from
 * the others, and that every appointment lands on its own calendar day.
 *
 * Separation is verified through the application's tenant-scoped repository
 * reads — the `tenant_id = $1` queries that enforce isolation in EVERY
 * environment (belt), independent of RLS (the suspenders, which the
 * migration-owner test role bypasses since tables are ENABLE, not FORCE RLS).
 *
 * The unit test (test/seed/seed-plan.test.ts) proves the default plan is 200
 * over 10 tenants; this proves the same machinery actually persists and
 * separates, at a smaller size for CI speed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb } from './shared';
import { runSeed } from '../../src/seed/seed-runner';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';

const PER_TENANT = 5;
const TENANTS = 3;
// Wide window covering every seeded appointment (startDate + index days).
const RANGE_START = new Date('2026-07-01T00:00:00Z');
const RANGE_END = new Date('2026-12-31T00:00:00Z');

describe('Postgres integration — demo seeder (multi-tenant separation)', () => {
  let pool: Pool;
  let tenantIds: string[];
  let customerRepo: PgCustomerRepository;
  let estimateRepo: PgEstimateRepository;
  let appointmentRepo: PgAppointmentRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    customerRepo = new PgCustomerRepository(pool);
    estimateRepo = new PgEstimateRepository(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
    const result = await runSeed(pool, {
      tenantCount: TENANTS,
      customersPerTenant: PER_TENANT,
      startDate: new Date('2026-08-01T00:00:00Z'),
    });
    tenantIds = result.tenantIds;
    // The runner reports exactly what it inserted.
    expect(result).toMatchObject({ customers: 15, estimates: 15, appointments: 15 });
    expect(new Set(tenantIds).size).toBe(TENANTS);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('gives each tenant its own 5 customers, 5 estimates, and 5 appointments', async () => {
    for (const tenantId of tenantIds) {
      const customers = await customerRepo.findByTenant(tenantId);
      const estimates = await estimateRepo.findByTenant(tenantId);
      const appointments = await appointmentRepo.findByDateRange(tenantId, RANGE_START, RANGE_END);

      expect(customers).toHaveLength(PER_TENANT);
      expect(estimates).toHaveLength(PER_TENANT);
      expect(appointments).toHaveLength(PER_TENANT);

      // Every row a tenant-scoped read returns belongs to that tenant — the
      // core multi-tenancy guarantee.
      expect(customers.every((c) => c.tenantId === tenantId)).toBe(true);
      expect(estimates.every((e) => e.tenantId === tenantId)).toBe(true);
      expect(appointments.every((a) => a.tenantId === tenantId)).toBe(true);
    }
  });

  it('separates tenant data — no customer, estimate, or appointment is shared', async () => {
    const customerIds: string[] = [];
    const estimateIds: string[] = [];
    const appointmentIds: string[] = [];
    for (const tenantId of tenantIds) {
      (await customerRepo.findByTenant(tenantId)).forEach((c) => customerIds.push(c.id));
      (await estimateRepo.findByTenant(tenantId)).forEach((e) => estimateIds.push(e.id));
      (await appointmentRepo.findByDateRange(tenantId, RANGE_START, RANGE_END)).forEach((a) =>
        appointmentIds.push(a.id),
      );
    }
    // 15 distinct ids of each kind across the three tenants — no row bleeds
    // from one tenant's reads into another's.
    expect(customerIds).toHaveLength(15);
    expect(new Set(customerIds).size).toBe(15);
    expect(estimateIds).toHaveLength(15);
    expect(new Set(estimateIds).size).toBe(15);
    expect(appointmentIds).toHaveLength(15);
    expect(new Set(appointmentIds).size).toBe(15);
  });

  it('cross-tenant attribution is clean at the DB level (GROUP BY check)', async () => {
    // Belt-and-suspenders: read across tenants (the owner role bypasses RLS) and
    // confirm the seeder partitioned every customer to exactly its own tenant.
    const { rows } = await pool.query<{ tenant_id: string; n: number }>(
      `SELECT tenant_id, COUNT(*)::int AS n FROM customers
        WHERE tenant_id = ANY($1) GROUP BY tenant_id`,
      [tenantIds],
    );
    expect(rows).toHaveLength(TENANTS);
    for (const r of rows) {
      expect(tenantIds).toContain(r.tenant_id);
      expect(r.n).toBe(PER_TENANT);
    }
  });

  it('schedules every appointment on its own calendar day (separate days/times)', async () => {
    const allDays: string[] = [];
    for (const tenantId of tenantIds) {
      const appts = await appointmentRepo.findByDateRange(tenantId, RANGE_START, RANGE_END);
      for (const a of appts) {
        allDays.push(a.scheduledStart.toISOString().slice(0, 10));
      }
    }
    expect(allDays).toHaveLength(15);
    // Across all three tenants, no two appointments share a day.
    expect(new Set(allDays).size).toBe(15);
  });
});
