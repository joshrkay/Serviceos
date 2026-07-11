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
});
