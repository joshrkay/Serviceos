import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { assignTechnician } from '../../src/appointments/assignment';
import { ConflictError } from '../../src/shared/errors';

/**
 * TEST-02 — concurrent booking race, pinned against REAL Postgres.
 *
 * Where the actual conflict protection lives: `appointment.ts`'s
 * `createAppointment()` has NO conflict awareness at all — it only dedups
 * on `idempotencyKey`. `ai/tasks/slot-conflict-checker.ts`
 * (DefaultSlotConflictChecker) is a read-then-decide pre-flight used ONLY
 * by the AI voice proposal path (create-appointment-task.ts) — it is a
 * classic TOCTOU check with no transaction/locking, so it cannot be the
 * authoritative race guard for two truly concurrent requests.
 *
 * The AUTHORITATIVE, race-safe guard for "same technician, overlapping
 * time slot" is the DB-level EXCLUDE constraint `no_double_booking` on
 * `appointment_assignments` (migration 131, schema.ts:3266) — a technician
 * is double-booked at the ASSIGNMENT step (`assignTechnician`,
 * appointments/assignment.ts), not at appointment creation. The
 * application-layer check inside `assignTechnician` (via
 * `detectOverlappingAppointments`) is documented in its own comment as a
 * "fast/friendly pre-flight" backstopped by this EXCLUDE constraint for
 * the actual cross-request race.
 *
 * `pg-assignment.test.ts` already pins `mapAssignmentDbError`'s 23P01 ->
 * ConflictError translation against a MOCKED pg error — exactly the gap
 * CLAUDE.md flags ("tests that mock the DB are never the only proof a
 * query works"). This file drives the real constraint under real
 * concurrency: two CONCURRENT `assignTechnician` calls for the SAME
 * technician on overlapping appointments, through the real
 * PgAssignmentRepository + PgAppointmentRepository.
 */
describe('Postgres integration — technician double-booking race (TEST-02)', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let customerId: string;
  let locationId: string;
  const now = Date.now();

  async function makeTechnician(): Promise<string> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role) VALUES ($1, $2, $3, $4, 'technician')`,
      [id, tenant.tenantId, `clerk_${id}`, `tech_${id}@example.com`],
    );
    return id;
  }

  async function makeAppointment(startMs: number, endMs: number) {
    const jobRepo = new PgJobRepository(pool);
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-RACE-${jobId.slice(0, 8)}`,
      summary: 'Double-booking race fixture',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const appointmentId = crypto.randomUUID();
    await appointmentRepo.create({
      id: appointmentId,
      tenantId: tenant.tenantId,
      jobId,
      scheduledStart: new Date(startMs),
      scheduledEnd: new Date(endMs),
      timezone: 'UTC',
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return appointmentId;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    tenant = await createTestTenant(pool);

    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Race',
      lastName: 'Booker',
      displayName: 'Race Booker',
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
      street1: '1 Race Ave',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('two CONCURRENT assignTechnician calls for the SAME technician on the SAME time slot: exactly one succeeds, the other is rejected as a conflict', async () => {
    const technicianId = await makeTechnician();
    const start = now + 24 * 3600_000;
    const end = start + 3600_000;

    // Two DISTINCT appointments occupying the IDENTICAL window — mirrors
    // "two concurrent create requests for the same (technicianId, time
    // slot)": both requests want this technician in this window, and each
    // is backed by its own appointment row (e.g. two dispatchers racing to
    // book the same tech for two different customers at the same time).
    const [apptA, apptB] = await Promise.all([
      makeAppointment(start, end),
      makeAppointment(start, end),
    ]);

    const results = await Promise.allSettled([
      assignTechnician(
        { tenantId: tenant.tenantId, appointmentId: apptA, technicianId, technicianRole: 'technician', assignedBy: tenant.userId },
        assignmentRepo,
        { appointmentRepo },
      ),
      assignTechnician(
        { tenantId: tenant.tenantId, appointmentId: apptB, technicianId, technicianRole: 'technician', assignedBy: tenant.userId },
        assignmentRepo,
        { appointmentRepo },
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one succeeds...
    expect(fulfilled).toHaveLength(1);
    // ...and the other is rejected as a conflict (either the application's
    // own overlap pre-flight caught it, or — if both raced past that
    // read — the DB EXCLUDE constraint's 23P01 surfaced as ConflictError).
    expect(rejected).toHaveLength(1);
    const rejection = rejected[0] as PromiseRejectedResult;
    expect(rejection.reason).toBeInstanceOf(ConflictError);

    // The DB agrees: only ONE assignment row exists for this technician
    // across both appointments.
    const assignments = await assignmentRepo.findByTechnician(tenant.tenantId, technicianId);
    expect(assignments).toHaveLength(1);
    expect([apptA, apptB]).toContain(assignments[0].appointmentId);
  });

  it('two CONCURRENT assignTechnician calls for DIFFERENT technicians on the SAME slot both succeed (control — not an over-broad lock)', async () => {
    const techA = await makeTechnician();
    const techB = await makeTechnician();
    const start = now + 48 * 3600_000;
    const end = start + 3600_000;
    const [apptA, apptB] = await Promise.all([
      makeAppointment(start, end),
      makeAppointment(start, end),
    ]);

    const results = await Promise.allSettled([
      assignTechnician(
        { tenantId: tenant.tenantId, appointmentId: apptA, technicianId: techA, technicianRole: 'technician', assignedBy: tenant.userId },
        assignmentRepo,
        { appointmentRepo },
      ),
      assignTechnician(
        { tenantId: tenant.tenantId, appointmentId: apptB, technicianId: techB, technicianRole: 'technician', assignedBy: tenant.userId },
        assignmentRepo,
        { appointmentRepo },
      ),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await assignmentRepo.findByTechnician(tenant.tenantId, techA)).toHaveLength(1);
    expect(await assignmentRepo.findByTechnician(tenant.tenantId, techB)).toHaveLength(1);
  });

  it('two CONCURRENT assignTechnician calls for the SAME technician on NON-overlapping slots both succeed', async () => {
    const technicianId = await makeTechnician();
    const startA = now + 72 * 3600_000;
    const endA = startA + 3600_000;
    // Starts exactly when A ends — the checker's strict-overlap semantics
    // (a.end > w.start must be FALSE at the boundary) treat this as free.
    const startB = endA;
    const endB = startB + 3600_000;

    const [apptA, apptB] = await Promise.all([
      makeAppointment(startA, endA),
      makeAppointment(startB, endB),
    ]);

    const results = await Promise.allSettled([
      assignTechnician(
        { tenantId: tenant.tenantId, appointmentId: apptA, technicianId, technicianRole: 'technician', assignedBy: tenant.userId },
        assignmentRepo,
        { appointmentRepo },
      ),
      assignTechnician(
        { tenantId: tenant.tenantId, appointmentId: apptB, technicianId, technicianRole: 'technician', assignedBy: tenant.userId },
        assignmentRepo,
        { appointmentRepo },
      ),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const assignments = await assignmentRepo.findByTechnician(tenant.tenantId, technicianId);
    expect(assignments).toHaveLength(2);
  });

  // A13 (2026-08-31 live sweep) — the coordinator's hypothesis was a
  // ghost-assignment false positive: the double-booking check joining
  // appointment_assignments to appointments WITHOUT excluding
  // canceled/completed appointments. Read statically first (both layers):
  //   - app layer: `detectOverlappingAppointments` (dispatch/validation.ts)
  //     filters on `ACTIVE_STATUSES = ['scheduled','confirmed',
  //     'in_progress']` before considering an overlap at all.
  //   - DB layer: the `no_double_booking` EXCLUDE constraint (migration 131)
  //     is scoped `WHERE (appointment_status NOT IN ('canceled','no_show'))`,
  //     kept in sync by `trg_appointments_sync_to_assignments` (AFTER UPDATE
  //     ON appointments, fires on any status change including the sweep
  //     harness's plain `UPDATE appointments SET status = 'canceled'`).
  // Both layers already filter correctly by inspection. These tests prove
  // it empirically against real Postgres rather than trusting the reading:
  // a canceled appointment's assignment must NOT block a new overlapping
  // one for the same technician, at BOTH layers, while a genuinely ACTIVE
  // overlapping assignment must still block (control — a guard that lets
  // everything through would pass the first half trivially).
  describe('a CANCELED appointment\'s assignment is not a ghost double-booking (A13)', () => {
    it('assignTechnician (app-layer pre-flight): a canceled appointment at the SAME slot does not block a new assignment for the same technician', async () => {
      const technicianId = await makeTechnician();
      const start = now + 96 * 3600_000;
      const end = start + 3600_000;

      const canceledAppt = await makeAppointment(start, end);
      await assignTechnician(
        { tenantId: tenant.tenantId, appointmentId: canceledAppt, technicianId, technicianRole: 'technician', assignedBy: tenant.userId },
        assignmentRepo,
        { appointmentRepo },
      );
      // Plain UPDATE — the exact shape scripts/ai-catalog-sweep/run-sweep.mjs
      // uses to quarantine prior-run appointment debris, and what fires
      // `trg_appointments_sync_to_assignments` to propagate the status onto
      // the assignment row's denormalized `appointment_status`.
      await pool.query(`UPDATE appointments SET status = 'canceled', updated_at = now() WHERE id = $1`, [
        canceledAppt,
      ]);

      const newAppt = await makeAppointment(start, end);
      await expect(
        assignTechnician(
          { tenantId: tenant.tenantId, appointmentId: newAppt, technicianId, technicianRole: 'technician', assignedBy: tenant.userId },
          assignmentRepo,
          { appointmentRepo },
        ),
      ).resolves.toMatchObject({ appointmentId: newAppt });

      const assignments = await assignmentRepo.findByTechnician(tenant.tenantId, technicianId);
      expect(assignments.map((a) => a.appointmentId).sort()).toEqual(
        [canceledAppt, newAppt].sort(),
      );
    });

    it('DB EXCLUDE constraint (no_double_booking): a raw assignment INSERT on the overlapping slot succeeds once the conflicting appointment is canceled', async () => {
      const technicianId = await makeTechnician();
      const start = now + 120 * 3600_000;
      const end = start + 3600_000;

      const apptA = await makeAppointment(start, end);
      const assignmentAId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO appointment_assignments (id, tenant_id, appointment_id, technician_id, is_primary, assigned_by, assigned_at)
         VALUES ($1, $2, $3, $4, true, $5, now())`,
        [assignmentAId, tenant.tenantId, apptA, technicianId, tenant.userId],
      );

      const apptB = await makeAppointment(start, end);
      const assignmentBId = crypto.randomUUID();

      // Still SCHEDULED — the EXCLUDE constraint must reject this raw
      // INSERT (control: proves the constraint is actually load-bearing
      // here, not vacuously permissive).
      await expect(
        pool.query(
          `INSERT INTO appointment_assignments (id, tenant_id, appointment_id, technician_id, is_primary, assigned_by, assigned_at)
           VALUES ($1, $2, $3, $4, true, $5, now())`,
          [assignmentBId, tenant.tenantId, apptB, technicianId, tenant.userId],
        ),
      ).rejects.toMatchObject({ code: '23P01', constraint: 'no_double_booking' });

      // Now cancel apptA — the sync trigger propagates the status onto
      // assignmentA's denormalized appointment_status, which takes it out
      // of the EXCLUDE constraint's WHERE clause.
      await pool.query(`UPDATE appointments SET status = 'canceled', updated_at = now() WHERE id = $1`, [
        apptA,
      ]);
      const denorm = await pool.query(
        `SELECT appointment_status FROM appointment_assignments WHERE id = $1`,
        [assignmentAId],
      );
      expect(denorm.rows[0].appointment_status).toBe('canceled');

      // The identical INSERT that just failed now succeeds.
      await pool.query(
        `INSERT INTO appointment_assignments (id, tenant_id, appointment_id, technician_id, is_primary, assigned_by, assigned_at)
         VALUES ($1, $2, $3, $4, true, $5, now())`,
        [assignmentBId, tenant.tenantId, apptB, technicianId, tenant.userId],
      );
      const rows = await pool.query(
        `SELECT id FROM appointment_assignments WHERE tenant_id = $1 AND appointment_id = $2`,
        [tenant.tenantId, apptB],
      );
      expect(rows.rows).toHaveLength(1);
    });
  });
});
