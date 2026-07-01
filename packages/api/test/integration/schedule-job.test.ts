import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { InMemoryAssignmentRepository } from '../../src/appointments/assignment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgJobTimelineRepository } from '../../src/jobs/pg-job-lifecycle';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { scheduleJob } from '../../src/jobs/schedule-job';
import { getDispatchBoardData } from '../../src/dispatch/board-query';

/**
 * Issue 2 (dispatch board) — proves the data path end to end against Postgres:
 * scheduling a `new` job creates an appointment row that the dispatch board's
 * query surfaces in the unassigned queue, and the job flips to `scheduled`.
 */
describe('Postgres integration — schedule job → appointment → dispatch board', () => {
  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: InMemoryAssignmentRepository;
  let jobRepo: PgJobRepository;
  let timelineRepo: PgJobTimelineRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;
  let locationId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new InMemoryAssignmentRepository();
    jobRepo = new PgJobRepository(pool);
    timelineRepo = new PgJobTimelineRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Test',
      lastName: 'Customer',
      displayName: 'Test Customer',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '123 Main St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function createNewJob(jobNumber: string): Promise<string> {
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber,
      summary: 'AC not cooling',
      status: 'new',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return jobId;
  }

  it('scheduling a job creates an appointment that appears on the board', async () => {
    const jobId = await createNewJob('JOB-SCHED-1');

    // Noon UTC today, queried in UTC, sidesteps day-boundary flake.
    const start = new Date();
    start.setUTCHours(12, 0, 0, 0);
    const dateStr = start.toISOString().split('T')[0];

    const { job, appointment } = await scheduleJob(
      { jobRepo, appointmentRepo, timelineRepo, auditRepo },
      {
        tenantId: tenant.tenantId,
        jobId,
        scheduledStart: start,
        timezone: 'UTC',
        actorId: tenant.userId,
        actorRole: 'dispatcher',
      },
    );

    expect(job.status).toBe('scheduled');
    expect(appointment.jobId).toBe(jobId);

    // Persisted to the appointments table.
    const persisted = await appointmentRepo.findByJob(tenant.tenantId, jobId);
    expect(persisted.map((a) => a.id)).toContain(appointment.id);

    // The job is re-read as scheduled.
    const reread = await jobRepo.findById(tenant.tenantId, jobId);
    expect(reread?.status).toBe('scheduled');

    // The board surfaces it as an unassigned appointment for the day.
    const board = await getDispatchBoardData(
      tenant.tenantId,
      dateStr,
      { appointmentRepo, assignmentRepo },
      'UTC',
    );
    const onBoard = board.unassignedAppointments.find((a) => a.jobId === jobId);
    expect(onBoard).toBeDefined();
  });

  it('rejects scheduling a job that belongs to another tenant', async () => {
    const jobId = await createNewJob('JOB-SCHED-2');
    const otherTenant = await createTestTenant(pool);

    // Under the other tenant's context the job is invisible (RLS), so the
    // schedule attempt must 404 rather than cross the tenant boundary.
    await expect(
      scheduleJob(
        { jobRepo, appointmentRepo, timelineRepo, auditRepo },
        {
          tenantId: otherTenant.tenantId,
          jobId,
          scheduledStart: new Date(),
          timezone: 'UTC',
          actorId: otherTenant.userId,
        },
      ),
    ).rejects.toThrow(/Job/);
  });
});
