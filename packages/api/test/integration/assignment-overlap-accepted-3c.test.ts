import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { assignTechnician } from '../../src/appointments/assignment';
import { ConflictError } from '../../src/shared/errors';
import { MIGRATIONS } from '../../src/db/schema';

/**
 * Dispatch FR-2 phase 3c — "Allow overlap if select by user", pinned against
 * REAL Postgres (migrations 346 + 349, originally shipped as 332 + 335):
 *
 *  - an `acceptOverlap` assignment lands with overlap_accepted = true and the
 *    `no_double_booking` EXCLUDE constraint lets it through;
 *  - the same clash WITHOUT the flag is still refused by the constraint
 *    (23P01 → ConflictError), so nothing implicit can double-book;
 *  - rescheduling the accepted visit clears the mark via the sync trigger, so
 *    the acceptance never outlives the window it was given for, and moving it
 *    back onto a clash is refused again;
 *  - rows 346 marked before 349 existed (empty overlap_accepted_with) are
 *    backfilled with the visits they overlap, so their next status change is
 *    not refused by the stricter guard.
 */
describe('Postgres integration — dispatcher-accepted overlap (FR-2 phase 3c)', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let auditRepo: PgAuditRepository;
  let jobId: string;
  let techId: string;
  // Far enough out that appointment-creation's "not in the past" rule holds.
  const base = Date.UTC(2027, 2, 10, 15, 0, 0);
  const at = (minutes: number) => new Date(base + minutes * 60_000);

  async function mkAppt(startMin: number, endMin: number): Promise<string> {
    const id = crypto.randomUUID();
    await appointmentRepo.create({
      id, tenantId: tenant.tenantId, jobId, scheduledStart: at(startMin), scheduledEnd: at(endMin),
      timezone: 'UTC', status: 'scheduled', holdPendingApproval: false, createdBy: tenant.userId,
      createdAt: new Date(), updatedAt: new Date(),
    });
    return id;
  }

  async function overlapAcceptedFlag(appointmentId: string): Promise<boolean | null> {
    const { rows } = await pool.query<{ overlap_accepted: boolean }>(
      `SELECT overlap_accepted FROM appointment_assignments WHERE tenant_id = $1 AND appointment_id = $2`,
      [tenant.tenantId, appointmentId],
    );
    return rows[0]?.overlap_accepted ?? null;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    tenant = await createTestTenant(pool);

    techId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role) VALUES ($1, $2, $3, $4, 'technician')`,
      [techId, tenant.tenantId, `clerk_${techId}`, `tech_${techId}@example.com`],
    );
    const customerId = crypto.randomUUID();
    await new PgCustomerRepository(pool).create({
      id: customerId, tenantId: tenant.tenantId, firstName: 'Over', lastName: 'Lap', displayName: 'Over Lap',
      preferredChannel: 'sms', smsConsent: true, isArchived: false, createdBy: tenant.userId,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await new PgLocationRepository(pool).create({
      id: locationId, tenantId: tenant.tenantId, customerId, street1: '3 Clash Ct', city: 'Austin', state: 'TX',
      postalCode: '78701', country: 'USA', isPrimary: true, addressType: 'service', isArchived: false,
      createdAt: new Date(), updatedAt: new Date(),
    });
    jobId = crypto.randomUUID();
    await new PgJobRepository(pool).create({
      id: jobId, tenantId: tenant.tenantId, customerId, locationId, jobNumber: `JOB-3C-${jobId.slice(0, 8)}`,
      summary: 'Accepted-overlap fixture', status: 'scheduled', priority: 'normal', createdBy: tenant.userId,
      createdAt: new Date(), updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('accepted overlap is stored and allowed; the same clash without the flag is refused by the constraint', async () => {
    const busy = await mkAppt(0, 60);
    const clash = await mkAppt(30, 90);
    const otherClash = await mkAppt(45, 75);
    await assignTechnician(
      { tenantId: tenant.tenantId, appointmentId: busy, technicianId: techId, technicianRole: 'technician', assignedBy: tenant.userId },
      assignmentRepo, { appointmentRepo, auditRepo, actorRole: 'owner' },
    );

    const accepted = await assignTechnician(
      { tenantId: tenant.tenantId, appointmentId: clash, technicianId: techId, technicianRole: 'technician', assignedBy: tenant.userId, acceptOverlapWith: [busy] },
      assignmentRepo, { appointmentRepo, auditRepo, actorRole: 'owner' },
    );
    expect(accepted.overlapAccepted).toBe(true);
    expect(await overlapAcceptedFlag(clash)).toBe(true);
    // Read back through the repo too: the column round-trips.
    const rows = await assignmentRepo.findByTechnician(tenant.tenantId, techId);
    expect(rows.find((r) => r.appointmentId === clash)?.overlapAccepted).toBe(true);
    expect(rows.find((r) => r.appointmentId === busy)?.overlapAccepted).toBeUndefined();
    const audit = await auditRepo.findByEntity(tenant.tenantId, 'appointment', clash);
    expect(audit.find((e) => e.eventType === 'appointment.technician_assigned')?.metadata).toMatchObject({ overlapAccepted: true });

    // Straight to the DB, skipping the app pre-flight: the EXCLUDE constraint
    // itself still refuses an unmarked overlapping row.
    await expect(assignmentRepo.create({
      id: crypto.randomUUID(), tenantId: tenant.tenantId, appointmentId: otherClash, technicianId: techId,
      isPrimary: true, assignedBy: tenant.userId, assignedAt: new Date(),
    })).rejects.toBeInstanceOf(ConflictError);
    expect(await overlapAcceptedFlag(otherClash)).toBeNull();

    // An unmarked row overlapping ONLY the accepted visit (60–90 clears
    // `busy`, clashes with `clash`) is outside the EXCLUDE index's view of
    // the accepted row; trg_overlap_accepted_guard refuses it anyway.
    const onlyAccepted = await mkAppt(60, 90);
    await expect(assignmentRepo.create({
      id: crypto.randomUUID(), tenantId: tenant.tenantId, appointmentId: onlyAccepted, technicianId: techId,
      isPrimary: true, assignedBy: tenant.userId, assignedAt: new Date(),
    })).rejects.toBeInstanceOf(ConflictError);
    expect(await overlapAcceptedFlag(onlyAccepted)).toBeNull();
    // An accepted row whose consent names a DIFFERENT visit is refused too:
    // the guard holds accepted rows to exactly overlap_accepted_with.
    await expect(assignmentRepo.create({
      id: crypto.randomUUID(), tenantId: tenant.tenantId, appointmentId: onlyAccepted, technicianId: techId,
      isPrimary: true, assignedBy: tenant.userId, assignedAt: new Date(),
      overlapAccepted: true, overlapAcceptedWith: [busy],
    })).rejects.toBeInstanceOf(ConflictError);
    // ...and the same slot, accepted against the accepted visit, is allowed.
    const stacked = await assignTechnician(
      { tenantId: tenant.tenantId, appointmentId: onlyAccepted, technicianId: techId, technicianRole: 'technician', assignedBy: tenant.userId, acceptOverlapWith: [clash] },
      assignmentRepo, { appointmentRepo, auditRepo, actorRole: 'owner' },
    );
    expect(stacked.overlapAccepted).toBe(true);
    const { rows: stackedRows } = await pool.query<{ overlap_accepted_with: string[] }>(
      `SELECT overlap_accepted_with FROM appointment_assignments WHERE tenant_id = $1 AND appointment_id = $2`,
      [tenant.tenantId, onlyAccepted],
    );
    expect(stackedRows[0].overlap_accepted_with).toEqual([clash]);
  });

  it('two racing unmarked bookings that overlap only an accepted visit are both refused (the guard serialises them)', async () => {
    const busy = await mkAppt(1200, 1260);
    const clash = await mkAppt(1230, 1290);
    await assignTechnician(
      { tenantId: tenant.tenantId, appointmentId: busy, technicianId: techId, technicianRole: 'technician', assignedBy: tenant.userId },
      assignmentRepo, { appointmentRepo, actorRole: 'owner' },
    );
    await assignTechnician(
      { tenantId: tenant.tenantId, appointmentId: clash, technicianId: techId, technicianRole: 'technician', assignedBy: tenant.userId, acceptOverlapWith: [busy] },
      assignmentRepo, { appointmentRepo, actorRole: 'owner' },
    );
    const [a, b] = await Promise.all([mkAppt(1260, 1290), mkAppt(1260, 1290)]);
    const results = await Promise.allSettled([a, b].map((appointmentId) => assignmentRepo.create({
      id: crypto.randomUUID(), tenantId: tenant.tenantId, appointmentId, technicianId: techId,
      isPrimary: true, assignedBy: tenant.userId, assignedAt: new Date(),
    })));
    expect(results.every((r) => r.status === 'rejected' && r.reason instanceof ConflictError)).toBe(true);
  });

  it('rescheduling the accepted visit clears the mark, and moving it back onto a clash is refused', async () => {
    const busy = await mkAppt(600, 660);
    const clash = await mkAppt(630, 690);
    await assignTechnician(
      { tenantId: tenant.tenantId, appointmentId: busy, technicianId: techId, technicianRole: 'technician', assignedBy: tenant.userId },
      assignmentRepo, { appointmentRepo, actorRole: 'owner' },
    );
    await assignTechnician(
      { tenantId: tenant.tenantId, appointmentId: clash, technicianId: techId, technicianRole: 'technician', assignedBy: tenant.userId, acceptOverlapWith: [busy] },
      assignmentRepo, { appointmentRepo, actorRole: 'owner' },
    );
    expect(await overlapAcceptedFlag(clash)).toBe(true);

    // A status change alone keeps the acceptance (the window did not move).
    await appointmentRepo.update(tenant.tenantId, clash, { status: 'confirmed' });
    expect(await overlapAcceptedFlag(clash)).toBe(true);

    // Moving the visit to a free slot drops the acceptance with it.
    await appointmentRepo.update(tenant.tenantId, clash, { scheduledStart: at(900), scheduledEnd: at(960) });
    expect(await overlapAcceptedFlag(clash)).toBe(false);
    const cleared = await pool.query<{ overlap_accepted_with: string[] }>(
      `SELECT overlap_accepted_with FROM appointment_assignments WHERE tenant_id = $1 AND appointment_id = $2`,
      [tenant.tenantId, clash],
    );
    expect(cleared.rows[0].overlap_accepted_with).toEqual([]);

    // Back onto the busy slot without a fresh acceptance: refused.
    await expect(
      appointmentRepo.update(tenant.tenantId, clash, { scheduledStart: at(630), scheduledEnd: at(690) }),
    ).rejects.toBeInstanceOf(ConflictError);
    const after = await appointmentRepo.findById(tenant.tenantId, clash);
    expect(after?.scheduledStart.getTime()).toBe(at(900).getTime());
  });

  it('335 backfills rows that 332 marked before overlap_accepted_with existed, so their next status change is not refused', async () => {
    const busy = await mkAppt(1800, 1860);
    const clash = await mkAppt(1830, 1890);
    await assignTechnician(
      { tenantId: tenant.tenantId, appointmentId: busy, technicianId: techId, technicianRole: 'technician', assignedBy: tenant.userId },
      assignmentRepo, { appointmentRepo, actorRole: 'owner' },
    );
    await assignTechnician(
      { tenantId: tenant.tenantId, appointmentId: clash, technicianId: techId, technicianRole: 'technician', assignedBy: tenant.userId, acceptOverlapWith: [busy] },
      assignmentRepo, { appointmentRepo, actorRole: 'owner' },
    );

    // Recreate the pre-335 state: accepted, but with nothing recorded about
    // which visit was accepted (the guard itself would refuse this write).
    await pool.query(`ALTER TABLE appointment_assignments DISABLE TRIGGER trg_overlap_accepted_guard`);
    await pool.query(
      `UPDATE appointment_assignments SET overlap_accepted_with = '{}' WHERE tenant_id = $1 AND appointment_id = $2`,
      [tenant.tenantId, clash],
    );
    await pool.query(`ALTER TABLE appointment_assignments ENABLE TRIGGER trg_overlap_accepted_guard`);
    // Without the backfill, a plain status change is refused by the guard.
    await expect(appointmentRepo.update(tenant.tenantId, clash, { status: 'confirmed' })).rejects.toBeInstanceOf(ConflictError);

    // Re-running 335 (the runner replays every migration on boot) fills it in.
    await pool.query(MIGRATIONS['349_assignment_overlap_accepted_with']);
    const { rows } = await pool.query<{ overlap_accepted: boolean; overlap_accepted_with: string[] }>(
      `SELECT overlap_accepted, overlap_accepted_with FROM appointment_assignments WHERE tenant_id = $1 AND appointment_id = $2`,
      [tenant.tenantId, clash],
    );
    expect(rows[0]).toEqual({ overlap_accepted: true, overlap_accepted_with: [busy] });
    // The row 332 did not mark is left alone.
    const { rows: busyRows } = await pool.query<{ overlap_accepted_with: string[] }>(
      `SELECT overlap_accepted_with FROM appointment_assignments WHERE tenant_id = $1 AND appointment_id = $2`,
      [tenant.tenantId, busy],
    );
    expect(busyRows[0].overlap_accepted_with).toEqual([]);

    await appointmentRepo.update(tenant.tenantId, clash, { status: 'confirmed' });
    expect(await overlapAcceptedFlag(clash)).toBe(true);
  });
});
