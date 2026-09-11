/**
 * Docker-gated integration test — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * SCH-D2 — the CUSTOMER-ANCHORED appointment lookup, against the REAL
 * schema.
 *
 * WHY THIS FILE EXISTS AT ALL. The unit test for this branch
 * (test/ai/resolution/pg-entity-resolver.test.ts) mocks the `pg.Pool`, so it
 * can prove the branch is TAKEN and the parameters are bound, and it cannot
 * prove a single column exists. That is the exact failure mode CLAUDE.md
 * names ("the entity resolver shipped with nonexistent column names because
 * its Pool was mocked") and that
 * docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md
 * catalogues four separate times over. The new query traverses
 * `appointments.job_id → jobs.customer_id` and LEFT JOINs
 * `appointment_assignments` + `users`; every one of those names is pinned
 * here by executing the real thing against the real migrations.
 *
 * Register case: delay-01 ("Text Garcia that I'm running twenty minutes
 * late") — the operator names the PERSON, never the visit.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { assignTechnician } from '../../src/appointments/assignment';
import type { AppointmentStatus } from '../../src/appointments/appointment';

describe('Postgres integration — customer-anchored appointment resolution (SCH-D2)', () => {
  let pool: Pool;
  let resolver: PgEntityResolver;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let jobRepo: PgJobRepository;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let tenant: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    resolver = new PgEntityResolver(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    jobRepo = new PgJobRepository(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    tenant = await createTestTenant(pool);
  }, 60_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedCustomer(displayName: string): Promise<string> {
    const id = crypto.randomUUID();
    await customerRepo.create({
      id,
      tenantId: tenant.tenantId,
      firstName: displayName,
      lastName: '',
      displayName,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId: id,
      street1: '1 QA Cedar Avenue',
      city: 'Phoenix',
      state: 'AZ',
      postalCode: '85001',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  async function seedJob(customerId: string, summary: string): Promise<string> {
    const jobId = crypto.randomUUID();
    const locations = await locationRepo.findByCustomer(tenant.tenantId, customerId);
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId: locations[0].id,
      jobNumber: `JOB-${jobId.slice(0, 8)}`,
      summary,
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return jobId;
  }

  async function seedAppointment(
    jobId: string,
    daysOut: number,
    opts: { status?: AppointmentStatus; technicianId?: string } = {},
  ): Promise<string> {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + daysOut);
    const id = crypto.randomUUID();
    await appointmentRepo.create({
      id,
      tenantId: tenant.tenantId,
      jobId,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 60 * 60 * 1000),
      timezone: 'America/Phoenix',
      status: opts.status ?? 'scheduled',
      holdPendingApproval: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    if (opts.technicianId) {
      await assignTechnician(
        {
          tenantId: tenant.tenantId,
          appointmentId: id,
          technicianId: opts.technicianId,
          technicianRole: 'technician',
          isPrimary: true,
          assignedBy: tenant.userId,
        },
        assignmentRepo,
      );
    }
    return id;
  }

  async function seedTechnician(firstName: string, lastName: string): Promise<string> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name)
       VALUES ($1, $2, $3, $4, 'technician', $5, $6)`,
      [
        id,
        tenant.tenantId,
        `clerk-${id}`,
        `${firstName}.${id.slice(0, 8)}@example.com`.toLowerCase(),
        firstName,
        lastName,
      ],
    );
    return id;
  }

  it('an EMPTY reference anchored on a customer resolves that customer’s one upcoming appointment', async () => {
    const customerId = await seedCustomer('Anchor One');
    const jobId = await seedJob(customerId, 'Anchor One HVAC install');
    const technicianId = await seedTechnician('Carlos', 'Vega');
    const appointmentId = await seedAppointment(jobId, 3, { technicianId });

    const result = await resolver.resolve({
      tenantId: tenant.tenantId,
      reference: '',
      kind: 'appointment',
      customerId,
    });

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.candidate.id).toBe(appointmentId);
      expect(result.candidate.kind).toBe('appointment');
      // The assignment LEFT JOIN really produced the tech's name — the hint
      // is what makes a two-candidate picker answerable.
      expect(result.candidate.hint).toBe('assigned to Carlos Vega');
    }
  });

  it('never leaks another customer’s appointment (the tenant-wide fallback it replaces would have)', async () => {
    const quiet = await seedCustomer('Anchor Quiet');
    const noisy = await seedCustomer('Anchor Noisy');
    const noisyJob = await seedJob(noisy, 'Anchor Noisy repair');
    await seedAppointment(noisyJob, 1);

    // `quiet` has a job but NO appointment; the only upcoming appointment in
    // the tenant belongs to `noisy`.
    await seedJob(quiet, 'Anchor Quiet repair');

    const result = await resolver.resolve({
      tenantId: tenant.tenantId,
      reference: '',
      kind: 'appointment',
      customerId: quiet,
    });

    expect(result.kind).toBe('not_found');
  });

  it('two upcoming appointments answer as an appointment-kind picker, never a pick', async () => {
    const customerId = await seedCustomer('Anchor Two');
    const jobA = await seedJob(customerId, 'Anchor Two install');
    const jobB = await seedJob(customerId, 'Anchor Two follow-up');
    const first = await seedAppointment(jobA, 2);
    const second = await seedAppointment(jobB, 5);

    const result = await resolver.resolve({
      tenantId: tenant.tenantId,
      reference: '',
      kind: 'appointment',
      customerId,
    });

    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates.map((c) => c.id)).toEqual([first, second]);
      expect(result.candidates.every((c) => c.kind === 'appointment')).toBe(true);
    }
  });

  it('excludes canceled and past appointments (they are not delay/confirm targets)', async () => {
    const customerId = await seedCustomer('Anchor Excluded');
    const jobId = await seedJob(customerId, 'Anchor Excluded install');
    await seedAppointment(jobId, 4, { status: 'canceled' });
    await seedAppointment(jobId, -2); // already happened

    const result = await resolver.resolve({
      tenantId: tenant.tenantId,
      reference: '',
      kind: 'appointment',
      customerId,
    });

    expect(result.kind).toBe('not_found');
  });

  it('a DAY phrase narrows to that customer’s appointments on that day only', async () => {
    const customerId = await seedCustomer('Anchor Day');
    const jobId = await seedJob(customerId, 'Anchor Day install');
    // Two upcoming visits, on different days: the day phrase must pick one.
    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 2);
    const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][
      soon.getUTCDay()
    ];
    const onDay = await seedAppointment(jobId, 2);
    await seedAppointment(jobId, 5);

    const result = await resolver.resolve({
      tenantId: tenant.tenantId,
      reference: weekday,
      kind: 'appointment',
      customerId,
    });

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') expect(result.candidate.id).toBe(onDay);
  });

  it('is tenant-scoped: another tenant’s customer id resolves nothing', async () => {
    const other = await createTestTenant(pool);
    const customerId = await seedCustomer('Anchor Isolated');
    const jobId = await seedJob(customerId, 'Anchor Isolated install');
    await seedAppointment(jobId, 3);

    const result = await resolver.resolve({
      tenantId: other.tenantId,
      reference: '',
      kind: 'appointment',
      customerId,
    });

    expect(result.kind).toBe('not_found');
  });
});
