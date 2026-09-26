/**
 * #1279 — one technician-assignment path, pinned against REAL Postgres.
 *
 * `appointment_assignments` is canonical (D-007). The Schedule page's "New
 * appointment" form and the appointment Reassign dialog used to write
 * `jobs.assigned_technician_id` directly, so the assignment relation the
 * dispatch board and the `no_double_booking` EXCLUDE constraint (migration
 * 131) read was never written: two overlapping appointments for one
 * technician both saved and the board showed "No technician lanes".
 *
 * This file drives the appointment routes the web forms now call, through
 * the production request-transaction middleware, and proves:
 *   1. creating an appointment with a technician writes the assignment row,
 *      derives the job field, and the dispatch board shows the tech's lane;
 *   2. an overlapping booking for the same technician is refused (409) and
 *      leaves no orphan appointment behind;
 *   3. the standalone assignment endpoint refuses a double-booking and
 *      assigns/clears otherwise, keeping the job field derived;
 *   4. migration 288 backfills assignment rows from legacy job-level values
 *      where missing, skips would-be double-bookings, and is one-shot.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import request from 'supertest';
import express, { Response, NextFunction } from 'express';
import { getSharedTestDb, createTestTenant, TestTenant } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgJobTimelineRepository } from '../../src/jobs/pg-job-lifecycle';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgUserRepository } from '../../src/users/pg-user';
import { createAppointmentRouter } from '../../src/routes/appointments';
import { permissiveTenantOwnership } from '../../src/shared/tenant-ownership';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import { getDispatchBoardData } from '../../src/dispatch/board-query';
import { MIGRATIONS } from '../../src/db/schema';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const DAY = '2026-10-14';
const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00.000Z`);

describe('Postgres integration — canonical technician assignment path (#1279)', () => {
  let pool: Pool;
  let tenant: TestTenant;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let jobRepo: PgJobRepository;
  let app: express.Express;
  let customerId: string;
  let locationId: string;

  async function makeTechnician(): Promise<string> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name)
       VALUES ($1, $2, $3, $4, 'technician', 'Lane', 'Tech')`,
      [id, tenant.tenantId, `clerk_${id}`, `tech_${id}@example.com`],
    );
    return id;
  }

  async function makeJob(assignedTechnicianId?: string): Promise<string> {
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-1279-${jobId.slice(0, 8)}`,
      summary: 'Assignment path fixture',
      status: 'new',
      priority: 'normal',
      assignedTechnicianId,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return jobId;
  }

  async function makeAppointment(jobId: string, start: Date, end: Date): Promise<string> {
    const id = crypto.randomUUID();
    await appointmentRepo.create({
      id,
      tenantId: tenant.tenantId,
      jobId,
      scheduledStart: start,
      scheduledEnd: end,
      timezone: 'UTC',
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  async function assignmentRows(appointmentId: string) {
    const { rows } = await pool.query(
      `SELECT technician_id, is_primary FROM appointment_assignments WHERE appointment_id = $1`,
      [appointmentId],
    );
    return rows as Array<{ technician_id: string; is_primary: boolean }>;
  }

  async function board() {
    return getDispatchBoardData(tenant.tenantId, DAY, { appointmentRepo, assignmentRepo }, 'UTC');
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    jobRepo = new PgJobRepository(pool);
    const timelineRepo = new PgJobTimelineRepository(pool);
    const auditRepo = new PgAuditRepository(pool);
    const userRepo = new PgUserRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Lane',
      lastName: 'Owner',
      displayName: 'Lane Owner',
      preferredChannel: 'sms',
      smsConsent: true,
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
      street1: '1 Lane St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    app = express();
    app.use(express.json());
    app.use((req, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: tenant.userId,
        canonicalUserId: tenant.userId,
        sessionId: 'sess-1279',
        tenantId: tenant.tenantId,
        role: 'owner',
      };
      next();
    });
    // Production wraps /api in the request transaction — mirror it so a
    // mid-request failure rolls back exactly as it does in prod.
    app.use('/api', withTenantTransaction(pool));
    app.use(
      '/api/appointments',
      createAppointmentRouter(
        appointmentRepo,
        permissiveTenantOwnership(),
        jobRepo,
        timelineRepo,
        { assignment: { assignmentRepo, userRepo } },
        auditRepo,
      ),
    );
  });

  it('create with a technician writes the assignment row, derives the job field, and shows the lane', async () => {
    const techId = await makeTechnician();
    const jobId = await makeJob();

    const res = await request(app)
      .post('/api/appointments')
      .send({
        jobId,
        scheduledStart: at('10:30').toISOString(),
        scheduledEnd: at('11:30').toISOString(),
        timezone: 'UTC',
        technicianId: techId,
      });
    expect(res.status).toBe(201);

    expect(await assignmentRows(res.body.id)).toEqual([{ technician_id: techId, is_primary: true }]);
    const job = await jobRepo.findById(tenant.tenantId, jobId);
    expect(job?.assignedTechnicianId).toBe(techId);

    const data = await board();
    const lane = data.technicianLanes.find((l) => l.technicianId === techId);
    expect(lane?.appointments.map((a) => a.id)).toEqual([res.body.id]);
    expect(data.unassignedAppointments.map((a) => a.id)).not.toContain(res.body.id);
  });

  it('refuses an overlapping booking for the same technician and leaves no orphan appointment', async () => {
    const techId = await makeTechnician();
    const jobA = await makeJob();
    const jobB = await makeJob();

    const first = await request(app).post('/api/appointments').send({
      jobId: jobA,
      scheduledStart: at('13:00').toISOString(),
      scheduledEnd: at('14:00').toISOString(),
      timezone: 'UTC',
      technicianId: techId,
    });
    expect(first.status).toBe(201);

    const second = await request(app).post('/api/appointments').send({
      jobId: jobB,
      scheduledStart: at('13:30').toISOString(),
      scheduledEnd: at('14:30').toISOString(),
      timezone: 'UTC',
      technicianId: techId,
    });
    expect(second.status).toBe(409);

    // Atomic: the refused request created nothing for job B.
    expect(await appointmentRepo.findByJob(tenant.tenantId, jobB)).toEqual([]);
    const job = await jobRepo.findById(tenant.tenantId, jobB);
    expect(job?.assignedTechnicianId).toBeUndefined();
  });

  it('the assignment endpoint refuses a double-booking, assigns otherwise, and clears with null', async () => {
    const techId = await makeTechnician();
    const jobA = await makeJob();
    const jobB = await makeJob();
    const busy = await makeAppointment(jobA, at('15:00'), at('16:00'));
    const clash = await makeAppointment(jobB, at('15:30'), at('16:30'));

    const ok = await request(app).post(`/api/appointments/${busy}/assignments`).send({ technicianId: techId });
    expect(ok.status).toBe(200);
    expect(await assignmentRows(busy)).toEqual([{ technician_id: techId, is_primary: true }]);
    expect((await jobRepo.findById(tenant.tenantId, jobA))?.assignedTechnicianId).toBe(techId);

    const refused = await request(app)
      .post(`/api/appointments/${clash}/assignments`)
      .send({ technicianId: techId });
    expect(refused.status).toBe(409);
    expect(await assignmentRows(clash)).toEqual([]);
    expect((await jobRepo.findById(tenant.tenantId, jobB))?.assignedTechnicianId).toBeUndefined();

    const cleared = await request(app).post(`/api/appointments/${busy}/assignments`).send({ technicianId: null });
    expect(cleared.status).toBe(200);
    expect(await assignmentRows(busy)).toEqual([]);
    expect((await jobRepo.findById(tenant.tenantId, jobA))?.assignedTechnicianId).toBeUndefined();
  });

  it('migration 288 backfills assignment rows from job-level values where missing, skips clashes, and is one-shot', async () => {
    const migration = (MIGRATIONS as Record<string, string>)['288_backfill_appointment_assignments_from_jobs'];
    expect(migration, 'migration 288 must exist').toBeTruthy();

    const techId = await makeTechnician();
    const legacyJob = await makeJob(techId);
    const legacy = await makeAppointment(legacyJob, at('18:00'), at('19:00'));
    const clashJob = await makeJob(techId);
    const clash = await makeAppointment(clashJob, at('18:30'), at('19:30'));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The migration is one-shot, keyed on the provenance column it adds —
      // global-setup already ran it, so drop the column inside a rolled-back
      // transaction to exercise the first-run path.
      await client.query('ALTER TABLE appointment_assignments DROP COLUMN IF EXISTS backfill_source');
      await client.query(migration);

      const { rows } = await client.query(
        `SELECT appointment_id, technician_id, is_primary, backfill_source
           FROM appointment_assignments WHERE appointment_id = ANY($1::uuid[])`,
        [[legacy, clash]],
      );
      // Earliest wins; the overlapping one is skipped rather than failing boot.
      expect(rows).toEqual([
        { appointment_id: legacy, technician_id: techId, is_primary: true, backfill_source: 'job_assigned_technician' },
      ]);

      // A second boot is a no-op, even for an appointment whose assignment
      // was later removed on purpose.
      await client.query('DELETE FROM appointment_assignments WHERE appointment_id = $1', [legacy]);
      await client.query(migration);
      const again = await client.query(
        'SELECT 1 FROM appointment_assignments WHERE appointment_id = ANY($1::uuid[])',
        [[legacy, clash]],
      );
      expect(again.rows).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
