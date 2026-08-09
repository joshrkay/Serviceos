/**
 * VQ-002 — InMemoryAppointmentRepository (canonical module).
 *
 * Voice Quality Layer 1 corpus seeding imports the in-memory appointment repo
 * from `src/appointments/in-memory-appointment.ts`. These tests pin the
 * contract against the existing `AppointmentRepository` interface and exercise
 * tenant-isolation + status-transition + date-range invariants.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryAssignmentRepository } from '../../src/appointments/assignment';
import type {
  Appointment,
  AppointmentRepository,
  AppointmentStatus,
} from '../../src/appointments/appointment';

const tenantA = '00000000-0000-4000-8000-00000000000a';
const tenantB = '00000000-0000-4000-8000-00000000000b';

function makeAppt(overrides: Partial<Appointment> = {}): Appointment {
  const start = overrides.scheduledStart ?? new Date('2026-05-10T15:00:00Z');
  const end = overrides.scheduledEnd ?? new Date('2026-05-10T16:00:00Z');
  return {
    id: overrides.id ?? `appt-${Math.random().toString(36).slice(2, 10)}`,
    tenantId: overrides.tenantId ?? tenantA,
    jobId: overrides.jobId ?? 'job-1',
    scheduledStart: start,
    scheduledEnd: end,
    arrivalWindowStart: overrides.arrivalWindowStart,
    arrivalWindowEnd: overrides.arrivalWindowEnd,
    timezone: overrides.timezone ?? 'America/Los_Angeles',
    status: (overrides.status ?? 'scheduled') as AppointmentStatus,
    idempotencyKey: overrides.idempotencyKey,
    notes: overrides.notes,
    createdBy: overrides.createdBy ?? 'user-1',
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
  };
}

describe('VQ-002 — InMemoryAppointmentRepository (canonical module)', () => {
  let repo: InMemoryAppointmentRepository;

  beforeEach(() => {
    repo = new InMemoryAppointmentRepository();
  });

  it('VQ-002 — implements AppointmentRepository interface', () => {
    const asInterface: AppointmentRepository = repo;
    expect(typeof asInterface.create).toBe('function');
    expect(typeof asInterface.findById).toBe('function');
    expect(typeof asInterface.findByJob).toBe('function');
    expect(typeof asInterface.findByDateRange).toBe('function');
    expect(typeof asInterface.update).toBe('function');
  });

  it('VQ-002 — happy path: create + findById round-trip', async () => {
    const appt = makeAppt({ id: 'appt-001', jobId: 'job-42' });
    await repo.create(appt);

    const found = await repo.findById(tenantA, 'appt-001');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('appt-001');
    expect(found!.jobId).toBe('job-42');
    expect(found!.status).toBe('scheduled');
  });

  it('VQ-002 — tenant isolation: tenant B cannot read tenant A appointment', async () => {
    const appt = makeAppt({ id: 'appt-iso', tenantId: tenantA });
    await repo.create(appt);

    const fromB = await repo.findById(tenantB, 'appt-iso');
    expect(fromB).toBeNull();

    const byJobFromB = await repo.findByJob(tenantB, appt.jobId);
    expect(byJobFromB).toEqual([]);

    const fromA = await repo.findById(tenantA, 'appt-iso');
    expect(fromA).not.toBeNull();
  });

  it('VQ-002 — findByJob: returns appointments matching jobId in tenant context', async () => {
    await repo.create(makeAppt({ id: 'a1', jobId: 'job-A', tenantId: tenantA }));
    await repo.create(makeAppt({ id: 'a2', jobId: 'job-A', tenantId: tenantA }));
    await repo.create(makeAppt({ id: 'a3', jobId: 'job-B', tenantId: tenantA }));
    await repo.create(makeAppt({ id: 'a4', jobId: 'job-A', tenantId: tenantB }));

    const results = await repo.findByJob(tenantA, 'job-A');
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id).sort()).toEqual(['a1', 'a2']);
  });

  it('VQ-002 — findByDateRange: inclusive boundary conditions', async () => {
    const start = new Date('2026-05-01T00:00:00Z');
    const end = new Date('2026-05-31T23:59:59Z');

    await repo.create(
      makeAppt({ id: 'before', scheduledStart: new Date('2026-04-30T23:00:00Z'), scheduledEnd: new Date('2026-04-30T23:59:00Z') })
    );
    await repo.create(
      makeAppt({ id: 'on-start', scheduledStart: start, scheduledEnd: new Date('2026-05-01T01:00:00Z') })
    );
    await repo.create(
      makeAppt({ id: 'middle', scheduledStart: new Date('2026-05-15T12:00:00Z'), scheduledEnd: new Date('2026-05-15T13:00:00Z') })
    );
    await repo.create(
      makeAppt({ id: 'on-end', scheduledStart: end, scheduledEnd: new Date('2026-06-01T00:30:00Z') })
    );
    await repo.create(
      makeAppt({ id: 'after', scheduledStart: new Date('2026-06-01T00:00:00Z'), scheduledEnd: new Date('2026-06-01T01:00:00Z') })
    );

    const results = await repo.findByDateRange(tenantA, start, end);
    const ids = results.map((r) => r.id).sort();
    expect(ids).toEqual(['middle', 'on-end', 'on-start']);
  });

  it('VQ-002 — findByDateRange respects tenant isolation', async () => {
    await repo.create(
      makeAppt({
        id: 'in-range-a',
        tenantId: tenantA,
        scheduledStart: new Date('2026-05-15T12:00:00Z'),
        scheduledEnd: new Date('2026-05-15T13:00:00Z'),
      })
    );
    const results = await repo.findByDateRange(
      tenantB,
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-05-31T23:59:59Z')
    );
    expect(results).toEqual([]);
  });

  it('VQ-002 — update: status transition scheduled → confirmed → completed', async () => {
    const appt = makeAppt({ id: 'appt-st', status: 'scheduled' });
    await repo.create(appt);

    const confirmed = await repo.update(tenantA, 'appt-st', { status: 'confirmed' });
    expect(confirmed!.status).toBe('confirmed');

    const completed = await repo.update(tenantA, 'appt-st', { status: 'completed' });
    expect(completed!.status).toBe('completed');

    const refetched = await repo.findById(tenantA, 'appt-st');
    expect(refetched!.status).toBe('completed');
  });

  it('VQ-002 — update returns null on cross-tenant attempt', async () => {
    await repo.create(makeAppt({ id: 'appt-ct', tenantId: tenantA }));
    const result = await repo.update(tenantB, 'appt-ct', { status: 'canceled' });
    expect(result).toBeNull();
  });

  it('VQ-002 — returns copy, not reference: mutating result does not corrupt repo', async () => {
    const appt = makeAppt({ id: 'appt-cp', notes: 'original notes' });
    await repo.create(appt);

    const found = await repo.findById(tenantA, 'appt-cp');
    expect(found).not.toBeNull();
    found!.notes = 'mutated notes';
    found!.status = 'canceled';

    const refetched = await repo.findById(tenantA, 'appt-cp');
    expect(refetched!.notes).toBe('original notes');
    expect(refetched!.status).toBe('scheduled');
  });

  it('VQ-002 — create snapshots input: mutating input after create does not corrupt repo', async () => {
    const appt = makeAppt({ id: 'appt-snap', notes: 'pristine' });
    await repo.create(appt);
    appt.notes = 'tampered';
    appt.status = 'canceled';

    const refetched = await repo.findById(tenantA, 'appt-snap');
    expect(refetched!.notes).toBe('pristine');
    expect(refetched!.status).toBe('scheduled');
  });

  it('VQ-002 — listWithMeta: filters by status + paginates', async () => {
    for (let i = 0; i < 4; i++) {
      await repo.create(
        makeAppt({
          id: `appt-meta-${i}`,
          status: i % 2 === 0 ? 'scheduled' : 'confirmed',
          scheduledStart: new Date(2026, 4, 10 + i, 9, 0, 0),
          scheduledEnd: new Date(2026, 4, 10 + i, 10, 0, 0),
        })
      );
    }

    const result = await repo.listWithMeta!(tenantA, { status: 'scheduled' });
    expect(result.total).toBe(2);
    expect(result.data.every((a) => a.status === 'scheduled')).toBe(true);
  });

  it('dedups create() by idempotencyKey — a redelivered write returns the existing hold', async () => {
    const first = await repo.create(
      makeAppt({ id: 'appt-idem-1', idempotencyKey: 'voice-hold:rec-1' }),
    );
    const second = await repo.create(
      makeAppt({ id: 'appt-idem-2', idempotencyKey: 'voice-hold:rec-1' }),
    );
    // The second insert is suppressed; we get the first row back.
    expect(first.id).toBe('appt-idem-1');
    expect(second.id).toBe('appt-idem-1');
    expect(await repo.findById(tenantA, 'appt-idem-2')).toBeNull();
  });

  it('idempotencyKey dedup is tenant-scoped and ignores keyless appointments', async () => {
    await repo.create(makeAppt({ id: 'a1', tenantId: tenantA, idempotencyKey: 'k' }));
    // Same key, different tenant → not deduped (separate row).
    const other = await repo.create(
      makeAppt({ id: 'b1', tenantId: tenantB, idempotencyKey: 'k' }),
    );
    expect(other.id).toBe('b1');
    // No key → never deduped.
    await repo.create(makeAppt({ id: 'c1', idempotencyKey: undefined }));
    await repo.create(makeAppt({ id: 'c2', idempotencyKey: undefined }));
    expect(await repo.findById(tenantA, 'c1')).not.toBeNull();
    expect(await repo.findById(tenantA, 'c2')).not.toBeNull();
  });
});

/**
 * Follow-up — technicianId filter parity with PgAppointmentRepository.
 *
 * PgAppointmentRepository.listWithMeta filters technicianId via an EXISTS
 * subquery against `appointment_assignments` (pg-appointment.ts ~L198-207).
 * The in-memory store has no such table and previously ignored the option
 * silently (comment used to read "best-effort only and silently ignored") —
 * `GET /api/appointments?technicianId=X` on an in-memory deployment returned
 * EVERY appointment in the tenant, filtered by nothing. Fixed by threading in
 * an assignment lookup (the real InMemoryAssignmentRepository in production
 * wiring) so both backends apply the identical semantics: "does an assignment
 * row link this appointment to this technician".
 */
describe('InMemoryAppointmentRepository — technicianId filter (parity with Pg)', () => {
  let repo: InMemoryAppointmentRepository;
  let assignments: InMemoryAssignmentRepository;

  beforeEach(() => {
    assignments = new InMemoryAssignmentRepository();
    repo = new InMemoryAppointmentRepository(assignments);
  });

  async function assign(appointmentId: string, technicianId: string) {
    await assignments.create({
      id: `asg-${appointmentId}-${technicianId}`,
      tenantId: tenantA,
      appointmentId,
      technicianId,
      isPrimary: true,
      assignedBy: 'dispatcher-1',
      assignedAt: new Date(),
    });
  }

  it('listWithMeta: returns only appointments assigned to the given technicianId', async () => {
    await repo.create(makeAppt({ id: 'a1' }));
    await repo.create(makeAppt({ id: 'a2' }));
    await repo.create(makeAppt({ id: 'a3' }));
    await assign('a1', 'tech-1');
    await assign('a3', 'tech-1');
    await assign('a2', 'tech-2');

    const result = await repo.listWithMeta!(tenantA, { technicianId: 'tech-1' });
    expect(result.total).toBe(2);
    expect(result.data.map((a) => a.id).sort()).toEqual(['a1', 'a3']);
  });

  it('listWithMeta: technicianId with no matching assignments returns empty, not everything', async () => {
    await repo.create(makeAppt({ id: 'a1' }));
    await repo.create(makeAppt({ id: 'a2' }));
    await assign('a1', 'tech-1');

    const result = await repo.listWithMeta!(tenantA, { technicianId: 'tech-unassigned' });
    expect(result.total).toBe(0);
    expect(result.data).toEqual([]);
  });

  it('listWithMeta: technicianId combines with status filter (AND semantics)', async () => {
    await repo.create(makeAppt({ id: 'a1', status: 'scheduled' }));
    // Same status as a1 but a DIFFERENT technician — must be excluded by the
    // technicianId filter even though it passes the status filter, so this
    // case fails red if technicianId isn't actually applied.
    await repo.create(makeAppt({ id: 'a2', status: 'scheduled' }));
    await repo.create(makeAppt({ id: 'a3', status: 'completed' }));
    await assign('a1', 'tech-1');
    await assign('a2', 'tech-2');
    await assign('a3', 'tech-1');

    const result = await repo.listWithMeta!(tenantA, {
      technicianId: 'tech-1',
      status: 'scheduled',
    });
    expect(result.total).toBe(1);
    expect(result.data[0].id).toBe('a1');
  });

  it('listWithMeta: technicianId filter is tenant-scoped even when the technician is assigned elsewhere', async () => {
    await repo.create(makeAppt({ id: 'a1', tenantId: tenantA }));
    // A second tenant-A appointment NOT assigned to the shared technician —
    // if technicianId filtering were a no-op, tenant scoping alone would
    // still (wrongly) include this row, so this case fails red without the
    // fix even though cross-tenant leakage is not what it's pinning.
    await repo.create(makeAppt({ id: 'a2', tenantId: tenantA }));
    await repo.create(makeAppt({ id: 'b1', tenantId: tenantB }));
    // Same technician id assigned in both tenants — cross-tenant leakage would
    // show up as tenant B's appointment count under tenant A's query.
    await assignments.create({
      id: 'asg-b1',
      tenantId: tenantB,
      appointmentId: 'b1',
      technicianId: 'tech-shared',
      isPrimary: true,
      assignedBy: 'dispatcher-2',
      assignedAt: new Date(),
    });
    await assign('a1', 'tech-shared');

    const result = await repo.listWithMeta!(tenantA, { technicianId: 'tech-shared' });
    expect(result.total).toBe(1);
    expect(result.data[0].id).toBe('a1');
  });

  it('listWithMeta: throws (fails loud) when technicianId is requested but no assignment lookup was configured', async () => {
    const bareRepo = new InMemoryAppointmentRepository();
    await bareRepo.create(makeAppt({ id: 'a1' }));

    await expect(
      bareRepo.listWithMeta!(tenantA, { technicianId: 'tech-1' }),
    ).rejects.toThrow(/technicianId/i);
  });
});
