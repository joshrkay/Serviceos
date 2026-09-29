/**
 * #1472 — PUT /api/appointments/:id rescheduling an ASSIGNED appointment into
 * the same technician's overlapping slot must be a 409 double-booking
 * conflict (like create/assign), not a 500. The `no_double_booking` EXCLUDE
 * constraint only exists in Postgres, so this runs against real Postgres
 * through the production request-transaction middleware.
 *
 * Root cause (found against the dev DB): databases that once ran the
 * withdrawn migration `129_double_booking_exclusion` still carry its
 * BEFORE INSERT OR UPDATE trigger `trg_no_double_booking`, which raises
 * SQLSTATE 23P01 with NO constraint name ("DOUBLE_BOOKING: technician …").
 * It fires before migration 131's EXCLUDE constraint, so a reschedule
 * (whose sync trigger UPDATEs the assignment row) surfaced as an unmapped
 * 500. Create/assign never hit it because their app-level pre-flight
 * refuses the overlap first. The suite replicates that legacy trigger —
 * scoped to this file's tenant so it can't affect other suites — and
 * drops it afterwards.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { MIGRATIONS } from '../../src/db/schema';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const DAY = '2026-11-18';
const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00.000Z`);

describe('Postgres integration — reschedule into a double-booking (#1472)', () => {
  let pool: Pool;
  let tenant: TestTenant;
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

  async function makeJob(): Promise<string> {
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-1472-${jobId.slice(0, 8)}`,
      summary: 'Reschedule conflict fixture',
      status: 'new',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return jobId;
  }

  async function bookFor(techId: string, start: string, end: string): Promise<string> {
    const jobId = await makeJob();
    const res = await request(app).post('/api/appointments').send({
      jobId,
      scheduledStart: at(start).toISOString(),
      scheduledEnd: at(end).toISOString(),
      timezone: 'UTC',
      technicianId: techId,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    const appointmentRepo = new PgAppointmentRepository(pool);
    const assignmentRepo = new PgAssignmentRepository(pool);
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

    // Legacy migration-129 trigger under its real names, verbatim except for
    // the tenant guard. (Names matter: Postgres fires same-timing triggers
    // in NAME order, so it runs after trg_assignment_sync_appointment_fields
    // has filled the window — exactly as on the dev DB.)
    await pool.query(`
      CREATE OR REPLACE FUNCTION check_no_double_booking()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE conflict_count INTEGER;
      BEGIN
        IF NEW.tenant_id <> '${tenant.tenantId}'::UUID THEN RETURN NEW; END IF;
        IF NEW.scheduled_start IS NULL OR NEW.scheduled_end IS NULL THEN RETURN NEW; END IF;
        SELECT COUNT(*) INTO conflict_count
        FROM appointment_assignments aa
        JOIN appointments a ON a.id = aa.appointment_id
        WHERE aa.tenant_id = NEW.tenant_id
          AND aa.technician_id = NEW.technician_id
          AND aa.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::UUID)
          AND a.status NOT IN ('cancelled_by_customer', 'cancelled_by_business')
          AND NEW.scheduled_start < aa.scheduled_end
          AND NEW.scheduled_end > aa.scheduled_start;
        IF conflict_count > 0 THEN
          RAISE EXCEPTION 'DOUBLE_BOOKING: technician % already has an active assignment overlapping [%, %]',
            NEW.technician_id, NEW.scheduled_start, NEW.scheduled_end
            USING ERRCODE = 'exclusion_violation';
        END IF;
        RETURN NEW;
      END;
      $$;
      DROP TRIGGER IF EXISTS trg_no_double_booking ON appointment_assignments;
      CREATE TRIGGER trg_no_double_booking
        BEFORE INSERT OR UPDATE ON appointment_assignments
        FOR EACH ROW EXECUTE FUNCTION check_no_double_booking();
    `);

    app = express();
    app.use(express.json());
    app.use((req, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: tenant.userId,
        canonicalUserId: tenant.userId,
        sessionId: 'sess-1472',
        tenantId: tenant.tenantId,
        role: 'owner',
      };
      next();
    });
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

  afterAll(async () => {
    await pool.query(`
      DROP TRIGGER IF EXISTS trg_no_double_booking ON appointment_assignments;
      DROP FUNCTION IF EXISTS check_no_double_booking();
    `);
  });

  it("rescheduling into the same technician's overlapping slot is a 409 conflict and changes nothing", async () => {
    const techId = await makeTechnician();
    const a = await bookFor(techId, '13:00', '14:00');
    await bookFor(techId, '16:00', '17:00');

    const res = await request(app).put(`/api/appointments/${a}`).send({
      scheduledStart: at('15:00').toISOString(),
      scheduledEnd: at('16:30').toISOString(),
    });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already booked/i);
    const after = await request(app).get(`/api/appointments/${a}`);
    expect(after.status).toBe(200);
    expect(new Date(after.body.scheduledStart).toISOString()).toBe(at('13:00').toISOString());
  });

  it('rescheduling an assigned appointment into a free slot still succeeds', async () => {
    const techId = await makeTechnician();
    const a = await bookFor(techId, '08:00', '09:00');
    await bookFor(techId, '11:00', '12:00');

    const res = await request(app).put(`/api/appointments/${a}`).send({
      scheduledStart: at('09:30').toISOString(),
      scheduledEnd: at('10:30').toISOString(),
    });
    expect(res.status).toBe(200);
  });

  // #1478 — the legacy trigger only skipped 'cancelled_by_*' statuses that no
  // longer exist, so a canceled visit kept blocking its technician's slot.
  // Migration 301 repairs the legacy function in place (where it exists).
  describe('with migration 301 applied (#1478)', () => {
    beforeAll(async () => {
      await pool.query(MIGRATIONS['301_legacy_double_booking_trigger_statuses']);
    });

    it('after canceling an assigned appointment, the same technician can be rebooked into its slot', async () => {
      const techId = await makeTechnician();
      const a = await bookFor(techId, '18:00', '19:00');

      const cancel = await request(app).put(`/api/appointments/${a}`).send({ status: 'canceled' });
      expect(cancel.status).toBe(200);

      const rebook = await request(app).post('/api/appointments').send({
        jobId: await makeJob(),
        scheduledStart: at('18:00').toISOString(),
        scheduledEnd: at('19:00').toISOString(),
        timezone: 'UTC',
        technicianId: techId,
      });
      expect(rebook.status).toBe(201);
    });

    it('a genuine overlap is still refused with 409', async () => {
      const techId = await makeTechnician();
      const a = await bookFor(techId, '06:00', '07:00');
      await bookFor(techId, '07:30', '08:00');
      const res = await request(app).put(`/api/appointments/${a}`).send({
        scheduledStart: at('06:30').toISOString(),
        scheduledEnd: at('07:45').toISOString(),
      });
      expect(res.status).toBe(409);
    });
  });
});
