/**
 * U6 — job → appointment sync against REAL Postgres. Pins the behaviors a
 * mocked Pool cannot prove (CLAUDE.md): the partial-unique idempotency index,
 * the `idempotency_key = NULL` release write, the `no_double_booking` EXCLUDE
 * surfacing as a 409 via the reschedule trigger, and the dispatch board
 * reading through real RLS-scoped reads.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { PgUserRepository } from '../../src/users/pg-user';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgJobTimelineRepository } from '../../src/jobs/pg-job-lifecycle';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { getJob } from '../../src/jobs/job';
import { ConflictError } from '../../src/shared/errors';
import { getDispatchBoardData, DispatchBoardData } from '../../src/dispatch/board-query';
import {
  JobAppointmentSyncDeps,
  jobScheduleKey,
  syncJobSchedule,
} from '../../src/jobs/job-appointment-sync';

const BOARD_DATE = '2030-09-01';
const T10 = '2030-09-01T10:00:00.000Z';
const T14 = '2030-09-01T14:00:00.000Z';

describe('Postgres integration — job-appointment sync', () => {
  let pool: Pool;
  let deps: JobAppointmentSyncDeps;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let jobRepo: PgJobRepository;
  let tenantId: string;
  let ownerId: string;
  let techId: string;
  let customerId: string;
  let locationId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    jobRepo = new PgJobRepository(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    const userRepo = new PgUserRepository(pool);
    const auditRepo = new PgAuditRepository(pool);
    const timelineRepo = new PgJobTimelineRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);

    deps = { jobRepo, appointmentRepo, assignmentRepo, userRepo, timelineRepo, auditRepo };

    const tenant = await createTestTenant(pool);
    tenantId = tenant.tenantId;
    ownerId = tenant.userId;

    // A technician the sync can assign (role-checked via userRepo.findById).
    techId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role) VALUES ($1, $2, $3, $4, $5)`,
      [techId, tenantId, techId, 'tech@example.com', 'technician'],
    );

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId, tenantId, firstName: 'Test', lastName: 'Customer', displayName: 'Test Customer',
      preferredChannel: 'phone', smsConsent: false, isArchived: false,
      createdBy: ownerId, createdAt: new Date(), updatedAt: new Date(),
    });

    locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId, tenantId, customerId, street1: '123 Main St', city: 'Austin', state: 'TX',
      postalCode: '78701', country: 'USA', isPrimary: true, addressType: 'service', isArchived: false,
      createdAt: new Date(), updatedAt: new Date(),
    });
  });

  // Isolate cases: the tenant + technician are shared across tests, so clear
  // the scheduling rows between them — otherwise appointments accumulate in the
  // real DB and reusing the same technician/slot in a later test trips the
  // no_double_booking guard.
  afterEach(async () => {
    await pool.query('DELETE FROM appointment_assignments WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM appointments WHERE tenant_id = $1', [tenantId]);
  });

  async function newJob(summary = 'Integration job'): Promise<string> {
    const id = crypto.randomUUID();
    await jobRepo.create({
      id, tenantId, customerId, locationId,
      jobNumber: `JOB-${id.slice(0, 8)}`, summary, status: 'new', priority: 'normal',
      depositRequiredCents: 0, depositPaidCents: 0, depositStatus: 'not_required', moneyState: 'no_estimate',
      createdBy: ownerId, createdAt: new Date(), updatedAt: new Date(),
    });
    return id;
  }

  async function newTech(): Promise<string> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role) VALUES ($1, $2, $3, $4, $5)`,
      [id, tenantId, id, `tech-${id}@example.com`, 'technician'],
    );
    return id;
  }

  function scheduleInput(jobId: string, scheduledStart: string, technicianId?: string) {
    return {
      operation: 'schedule' as const,
      tenantId, jobId, actorId: ownerId, actorRole: 'owner',
      scheduledStart: new Date(scheduledStart), technicianId, durationMin: 60,
    };
  }

  function board(date = BOARD_DATE): Promise<DispatchBoardData> {
    return getDispatchBoardData(tenantId, date, { appointmentRepo, assignmentRepo });
  }
  function activeOnBoard(b: DispatchBoardData, jobId: string) {
    return [...b.unassignedAppointments, ...b.technicianLanes.flatMap((l) => l.appointments)]
      .filter((a) => a.jobId === jobId && a.status !== 'canceled');
  }
  async function activeAppointments(jobId: string) {
    return (await appointmentRepo.findByJob(tenantId, jobId)).filter((a) => a.status !== 'canceled');
  }

  it('schedules a job onto the board and advances new → scheduled', async () => {
    const jobId = await newJob();
    const res = await syncJobSchedule(deps, scheduleInput(jobId, T10, techId));

    expect(res.appointment).not.toBeNull();
    expect(res.appointment!.idempotencyKey).toBe(jobScheduleKey(jobId));

    const job = await getJob(tenantId, jobId, jobRepo);
    expect(job!.status).toBe('scheduled');
    expect(job!.assignedTechnicianId).toBe(techId);

    const lane = (await board()).technicianLanes.find((l) => l.technicianId === techId);
    expect(lane?.appointments.some((a) => a.jobId === jobId)).toBe(true);
  });

  it('is idempotent against the partial-unique index: scheduling twice keeps one row', async () => {
    const jobId = await newJob();
    const first = await syncJobSchedule(deps, scheduleInput(jobId, T10, techId));
    const second = await syncJobSchedule(deps, scheduleInput(jobId, T10, techId));

    expect(second.appointment!.id).toBe(first.appointment!.id);
    expect(await activeAppointments(jobId)).toHaveLength(1);
  });

  it('reassign to null moves the appointment to the unassigned queue and clears the job tech', async () => {
    const jobId = await newJob();
    await syncJobSchedule(deps, scheduleInput(jobId, T10, techId));

    await syncJobSchedule(deps, {
      operation: 'reassign', tenantId, jobId, actorId: ownerId, actorRole: 'owner', technicianId: null,
    });

    const b = await board();
    expect(b.unassignedAppointments.some((a) => a.jobId === jobId)).toBe(true);
    expect((await getJob(tenantId, jobId, jobRepo))!.assignedTechnicianId).toBeUndefined();
  });

  it('unschedule releases the key (NULL) so a later schedule creates a FRESH row, not a revived cancel', async () => {
    const jobId = await newJob();
    const first = await syncJobSchedule(deps, scheduleInput(jobId, T10, techId));

    await syncJobSchedule(deps, { operation: 'unschedule', tenantId, jobId, actorId: ownerId, actorRole: 'owner' });

    const canceled = await appointmentRepo.findById(tenantId, first.appointment!.id);
    expect(canceled!.status).toBe('canceled');
    // Mapped value is undefined because the DB column is NULL.
    expect(canceled!.idempotencyKey ?? null).toBeNull();
    expect((await getJob(tenantId, jobId, jobRepo))!.status).toBe('new');

    // If the key were NOT released, createAppointment's ON CONFLICT would dedupe
    // back into the canceled row. A new, distinct, non-canceled row proves the
    // DB write set idempotency_key = NULL.
    const second = await syncJobSchedule(deps, scheduleInput(jobId, T10, techId));
    expect(second.appointment!.id).not.toBe(first.appointment!.id);
    expect(second.appointment!.status).toBe('scheduled');
    expect(await activeAppointments(jobId)).toHaveLength(1);
  });

  it('re-schedules after the canonical row was canceled OUT-OF-BAND (key left set) — releases stale key, no 409', async () => {
    const jobId = await newJob();
    const first = await syncJobSchedule(deps, scheduleInput(jobId, T10, techId));

    // Cancel the way /api/appointments/:id does: flip status only, leaving the
    // idempotency_key on the row (this module's own cancel would NULL it).
    await appointmentRepo.update(tenantId, first.appointment!.id, { status: 'canceled' });
    const stale = await appointmentRepo.findById(tenantId, first.appointment!.id);
    expect(stale!.idempotencyKey).toBe(jobScheduleKey(jobId)); // key still held on the canceled row

    // Without releasing that key, createAppointment's ON CONFLICT (partial-
    // unique index) would dedupe back into the canceled row and 409. The fix
    // NULLs the stale key first, so a fresh schedulable row is inserted.
    const second = await syncJobSchedule(deps, scheduleInput(jobId, T10, techId));
    expect(second.appointment!.id).not.toBe(first.appointment!.id);
    expect(second.appointment!.status).toBe('scheduled');
    expect(await activeAppointments(jobId)).toHaveLength(1);
    const released = await appointmentRepo.findById(tenantId, first.appointment!.id);
    expect(released!.status).toBe('canceled');
    expect(released!.idempotencyKey ?? null).toBeNull();
  });

  it('reschedule into a slot the technician already holds → 409, both times unchanged (no_double_booking)', async () => {
    const jobA = await newJob('Job A');
    const jobB = await newJob('Job B');
    await syncJobSchedule(deps, scheduleInput(jobA, T10, techId)); // tech busy 10:00–11:00
    const bSched = await syncJobSchedule(deps, scheduleInput(jobB, T14, techId)); // 14:00–15:00

    // Move B onto A's slot — the appointment time UPDATE fires the sync trigger,
    // whose assignment UPDATE trips the no_double_booking EXCLUDE (23P01).
    let caught: unknown;
    try {
      await syncJobSchedule(deps, scheduleInput(jobB, T10, techId));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictError);

    // Whole-update rolled back: B is still at 14:00 and A at 10:00.
    const reloadB = await appointmentRepo.findById(tenantId, bSched.appointment!.id);
    expect(reloadB!.scheduledStart.toISOString()).toBe(new Date(T14).toISOString());
    const aAppts = await appointmentRepo.findByJob(tenantId, jobA);
    expect(aAppts[0].scheduledStart.toISOString()).toBe(new Date(T10).toISOString());
  });

  it('cancelForJob cancels the appointment, releases the key, and clears the active board', async () => {
    const jobId = await newJob();
    await syncJobSchedule(deps, scheduleInput(jobId, T10, techId));

    await syncJobSchedule(deps, { operation: 'cancelForJob', tenantId, jobId, actorId: ownerId, actorRole: 'owner' });

    expect(await activeAppointments(jobId)).toHaveLength(0);
    expect(activeOnBoard(await board(), jobId)).toHaveLength(0);
  });

  it('cancelForJob reclaims an IN_PROGRESS visit — no live card left on the board', async () => {
    const jobId = await newJob();
    const first = await syncJobSchedule(deps, scheduleInput(jobId, T10, techId));
    // The visit starts (appointment lifecycle moves it to in_progress).
    await appointmentRepo.update(tenantId, first.appointment!.id, { status: 'in_progress' });

    await syncJobSchedule(deps, { operation: 'cancelForJob', tenantId, jobId, actorId: ownerId, actorRole: 'owner' });

    const appt = await appointmentRepo.findById(tenantId, first.appointment!.id);
    expect(appt!.status).toBe('canceled');
    expect(appt!.idempotencyKey ?? null).toBeNull();
    expect(await activeAppointments(jobId)).toHaveLength(0);
    expect(activeOnBoard(await board(), jobId)).toHaveLength(0);
  });

  it('reschedule + switch to a FREE tech succeeds even when the old tech is busy at the new time', async () => {
    const techB = await newTech();

    // The old tech (techId) is busy at T14 (the target slot) on another job.
    const busyJob = await newJob('old tech busy at T14');
    await syncJobSchedule(deps, scheduleInput(busyJob, T14, techId));

    // This job starts with the old tech at T10, then reschedules to T14 AND
    // switches to the free techB. Moving the time BEFORE switching would
    // re-stamp the old tech onto T14 and 409 against busyJob; switching first
    // must let this valid move succeed.
    const jobId = await newJob('move to free tech');
    await syncJobSchedule(deps, scheduleInput(jobId, T10, techId));

    const res = await syncJobSchedule(deps, {
      operation: 'schedule', tenantId, jobId, actorId: ownerId, actorRole: 'owner',
      scheduledStart: new Date(T14), technicianId: techB,
    });

    expect(res.appointment!.scheduledStart.toISOString()).toBe(new Date(T14).toISOString());
    const primaries = (await assignmentRepo.findByAppointment(tenantId, res.appointment!.id)).filter((a) => a.isPrimary);
    expect(primaries.map((a) => a.technicianId)).toEqual([techB]);
  });
});
