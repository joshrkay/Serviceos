import { describe, it, expect, vi } from 'vitest';
import { checkFeasibility } from '../../src/scheduling/feasibility';
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { Appointment } from '../../src/appointments/appointment';
import { noSkillConstraints } from '../helpers/no-skill-constraints';
import { HaversineFallbackProvider } from '../../src/scheduling/travel-time/haversine-fallback';
import { InMemoryAssignmentRepository } from '../../src/appointments/assignment';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';

function mkAppt(over: Partial<Appointment> = {}): Appointment {
  const start = new Date('2026-05-17T09:00:00Z');
  const end = new Date('2026-05-17T10:00:00Z');
  return {
    id: 'a-1', tenantId: 't-1', jobId: 'j-1',
    scheduledStart: start, scheduledEnd: end,
    timezone: 'UTC', status: 'scheduled',
    holdPendingApproval: false,
    createdBy: 'u-1', createdAt: start, updatedAt: start,
    ...over,
  };
}

function depsWith(siblings: Appointment[], technicianId: string): FeasibilityDependencies {
  const assignmentRepo: any = {
    findByTechnician: async () => siblings.map((s) => ({
      id: `as-${s.id}`, tenantId: s.tenantId, appointmentId: s.id,
      technicianId, isPrimary: true, assignedBy: 'u-1', assignedAt: s.createdAt,
    })),
    findByAppointment: async () => [],
  };
  const appointmentRepo: any = {
    findById: async (_t: string, id: string) => siblings.find((s) => s.id === id) ?? null,
  };
  return {
    assignmentRepo, appointmentRepo,
    jobRepo: { findById: async () => null } as any,
    locationRepo: { findById: async () => null } as any,
    workingHoursRepo: { findByTechnician: async () => [] } as any,
    unavailableBlockRepo: { findByTechnicianAndDateRange: async () => [] } as any,
    travelTimeProvider: new HaversineFallbackProvider(),
    skillMatcher: noSkillConstraints(),
  };
}

describe('checkFeasibility — overlap sub-check', () => {
  it('returns feasible with no issues when the technician is free', async () => {
    const appt = mkAppt();
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt.scheduledStart, proposedScheduledEnd: appt.scheduledEnd },
      depsWith([appt], 'tech-1'),
    );
    expect(r.feasible).toBe(true);
    expect(r.blocking).toHaveLength(0);
  });

  it('blocks when another sibling on the same technician overlaps', async () => {
    const appt = mkAppt({ id: 'a-target' });
    const conflict = mkAppt({
      id: 'a-conflict',
      scheduledStart: new Date('2026-05-17T09:30:00Z'),
      scheduledEnd: new Date('2026-05-17T10:30:00Z'),
    });
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt.scheduledStart, proposedScheduledEnd: appt.scheduledEnd },
      depsWith([appt, conflict], 'tech-1'),
    );
    expect(r.feasible).toBe(false);
    expect(r.blocking).toHaveLength(1);
    expect(r.blocking[0].check).toBe('overlap');
    expect(r.blocking[0].severity).toBe('blocking');
    expect(r.blocking[0].conflictingEntityId).toBe('a-conflict');
  });

  it('detects a cross-midnight overlap (proposed 23:30→00:30 vs sibling 00:00→01:00 next day)', async () => {
    const appt = mkAppt({
      id: 'a-target',
      scheduledStart: new Date('2026-05-17T23:30:00Z'),
      scheduledEnd: new Date('2026-05-18T00:30:00Z'),
    });
    const conflict = mkAppt({
      id: 'a-next',
      scheduledStart: new Date('2026-05-18T00:00:00Z'),
      scheduledEnd: new Date('2026-05-18T01:00:00Z'),
    });
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt.scheduledStart, proposedScheduledEnd: appt.scheduledEnd },
      depsWith([appt, conflict], 'tech-1'),
    );
    expect(r.feasible).toBe(false);
    expect(r.blocking[0].conflictingEntityId).toBe('a-next');
  });

  it('does NOT count the appointment-being-moved as its own conflict', async () => {
    const appt = mkAppt({ id: 'a-self' });
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt.scheduledStart, proposedScheduledEnd: appt.scheduledEnd },
      depsWith([appt], 'tech-1'),
    );
    expect(r.blocking).toHaveLength(0);
  });

  it('does NOT cap the sibling list — finds an overlap that would be missed by a small cap', async () => {
    const appt = mkAppt({
      id: 'a-target',
      scheduledStart: new Date('2026-05-17T15:00:00Z'),
      scheduledEnd: new Date('2026-05-17T16:00:00Z'),
    });
    // 100 non-overlapping siblings earlier in the day, then one overlapping sibling at the end.
    const noise = Array.from({ length: 100 }, (_, i) => mkAppt({
      id: `noise-${i}`,
      scheduledStart: new Date(`2026-05-17T${String(i % 24).padStart(2, '0')}:00:00Z`),
      scheduledEnd: new Date(`2026-05-17T${String(i % 24).padStart(2, '0')}:15:00Z`),
    }));
    const conflict = mkAppt({
      id: 'a-conflict-late',
      scheduledStart: new Date('2026-05-17T15:30:00Z'),
      scheduledEnd: new Date('2026-05-17T16:30:00Z'),
    });
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt.scheduledStart, proposedScheduledEnd: appt.scheduledEnd },
      depsWith([appt, ...noise, conflict], 'tech-1'),
    );
    expect(r.feasible).toBe(false);
    expect(r.blocking.some((b) => b.conflictingEntityId === 'a-conflict-late')).toBe(true);
  });
});

describe('checkFeasibility — no assigned technician (#909/A11, 2026-08-31 live sweep)', () => {
  // Live evidence: RescheduleAppointmentExecutionHandler's execution retried
  // forever on `invalid input syntax for type uuid: ""` — an unassigned
  // appointment's `proposedTechnicianId` reached `assignmentRepo.
  // findByTechnician` (and three sibling repo calls) as an empty string,
  // which Postgres rejects for a `uuid`-typed column. `proposedTechnicianId`
  // is now uuid-or-absent (#935/#947 doctrine): `undefined`, never `''`.
  function spyDeps(siblings: Appointment[]): {
    deps: FeasibilityDependencies;
    calls: { findByTechnician: number; findByTechnicianWorkingHours: number; findByTechnicianAndDateRange: number; skillsForTechnician: number };
  } {
    const calls = {
      findByTechnician: 0,
      findByTechnicianWorkingHours: 0,
      findByTechnicianAndDateRange: 0,
      skillsForTechnician: 0,
    };
    const deps: FeasibilityDependencies = {
      assignmentRepo: {
        findByTechnician: async () => {
          calls.findByTechnician += 1;
          return [];
        },
        findByAppointment: async () => [],
      } as any,
      appointmentRepo: {
        findById: async (_t: string, id: string) => siblings.find((s) => s.id === id) ?? null,
      } as any,
      jobRepo: { findById: async () => null } as any,
      locationRepo: { findById: async () => null } as any,
      workingHoursRepo: {
        findByTechnician: async () => {
          calls.findByTechnicianWorkingHours += 1;
          return [];
        },
      } as any,
      unavailableBlockRepo: {
        findByTechnicianAndDateRange: async () => {
          calls.findByTechnicianAndDateRange += 1;
          return [];
        },
      } as any,
      travelTimeProvider: new HaversineFallbackProvider(),
      skillMatcher: {
        // A required skill the technician HOLDS — this describe block is
        // about WHICH repo methods get called (skillsForTechnician is only
        // reached when a required skill exists at all), not skill-matching
        // outcomes (that's feasibility-skill.test.ts); keep the control
        // path's result clean (feasible: true) while still exercising the
        // call.
        requiredSkillsForJob: async () => ['licensed'],
        skillsForTechnician: async () => {
          calls.skillsForTechnician += 1;
          return ['licensed'];
        },
      } as any,
    };
    return { deps, calls };
  }

  it('returns feasible with no blocking issues, and never calls any per-technician repo method, when proposedTechnicianId is undefined', async () => {
    const appt = mkAppt();
    const { deps, calls } = spyDeps([appt]);

    const r = await checkFeasibility(
      {
        tenantId: 't-1',
        appointment: appt,
        proposedTechnicianId: undefined,
        proposedScheduledStart: appt.scheduledStart,
        proposedScheduledEnd: appt.scheduledEnd,
      },
      deps,
    );

    expect(r.feasible).toBe(true);
    expect(r.blocking).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
    expect(r.travelTime).toBeNull();
    // The actual regression proof: not one of the four per-technician repo
    // methods was ever invoked, so none could have been called with `''`.
    expect(calls.findByTechnician).toBe(0);
    expect(calls.findByTechnicianWorkingHours).toBe(0);
    expect(calls.findByTechnicianAndDateRange).toBe(0);
    expect(calls.skillsForTechnician).toBe(0);
  });

  it('still runs every check normally once a real technician id is supplied (guard is not over-broad)', async () => {
    const appt = mkAppt();
    const { deps, calls } = spyDeps([appt]);

    const r = await checkFeasibility(
      {
        tenantId: 't-1',
        appointment: appt,
        proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt.scheduledStart,
        proposedScheduledEnd: appt.scheduledEnd,
      },
      deps,
    );

    expect(r.feasible).toBe(true);
    expect(calls.findByTechnician).toBeGreaterThan(0);
    expect(calls.findByTechnicianWorkingHours).toBeGreaterThan(0);
    expect(calls.findByTechnicianAndDateRange).toBeGreaterThan(0);
    expect(calls.skillsForTechnician).toBeGreaterThan(0);
  });
});

describe('checkFeasibility — calendar reads', () => {
  it('reads only the assignments whose denormalised window touches the proposal, not every historical visit', async () => {
    const target = {
      id: 'a-target', tenantId: 't-1', jobId: 'j-1',
      scheduledStart: new Date('2026-05-17T10:00:00Z'), scheduledEnd: new Date('2026-05-17T11:00:00Z'),
      timezone: 'UTC', status: 'scheduled' as const, holdPendingApproval: false,
      createdBy: 'u', createdAt: new Date(), updatedAt: new Date(),
    };
    const clash = { ...target, id: 'a-clash', scheduledStart: new Date('2026-05-17T10:30:00Z'), scheduledEnd: new Date('2026-05-17T11:30:00Z') };
    const history = Array.from({ length: 50 }, (_, i) => ({
      appointmentId: `old-${i}`, technicianId: 'tech-1', isPrimary: true,
      scheduledStart: new Date(Date.UTC(2025, 0, 1 + i, 9)), scheduledEnd: new Date(Date.UTC(2025, 0, 1 + i, 10)),
    }));
    const findById = vi.fn(async (_t: string, id: string) => (id === 'a-clash' ? clash : null));
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: target, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: target.scheduledStart, proposedScheduledEnd: target.scheduledEnd },
      {
        assignmentRepo: { findByTechnician: async () => [
          ...history,
          { appointmentId: 'a-clash', technicianId: 'tech-1', isPrimary: true,
            scheduledStart: clash.scheduledStart, scheduledEnd: clash.scheduledEnd },
        ] } as any,
        appointmentRepo: { findById } as any,
        jobRepo: { findById: async () => null } as any,
        locationRepo: { findById: async () => null } as any,
        workingHoursRepo: { findByTechnician: async () => [] } as any,
        unavailableBlockRepo: { findByTechnicianAndDateRange: async () => [] } as any,
        travelTimeProvider: new HaversineFallbackProvider(),
        skillMatcher: noSkillConstraints(),
      },
    );
    expect(r.blocking.some((i) => i.check === 'overlap' && i.conflictingEntityId === 'a-clash')).toBe(true);
    // Overlap + travel each read the calendar once; neither touches the 50 old visits.
    expect(findById.mock.calls.every(([, id]) => id === 'a-clash')).toBe(true);
  });

  it('catches a visit rescheduled into the window on the in-memory repos, which keep no assignment copy in step', async () => {
    const assignmentRepo = new InMemoryAssignmentRepository();
    const appointmentRepo = new InMemoryAppointmentRepository(assignmentRepo);
    const target = mkAppt({ id: 'a-target', scheduledStart: new Date('2026-05-17T10:00:00Z'), scheduledEnd: new Date('2026-05-17T11:00:00Z') });
    // Booked a week out, so the assignment's copy of the window is far away…
    const moved = mkAppt({ id: 'a-moved', scheduledStart: new Date('2026-05-24T10:00:00Z'), scheduledEnd: new Date('2026-05-24T11:00:00Z') });
    await appointmentRepo.create(moved);
    await assignmentRepo.create({
      id: 'as-moved', tenantId: 't-1', appointmentId: 'a-moved', technicianId: 'tech-1', isPrimary: true,
      assignedBy: 'u-1', assignedAt: new Date(), scheduledStart: moved.scheduledStart, scheduledEnd: moved.scheduledEnd,
    });
    // …then rescheduled onto the target's slot; nothing updates that copy here.
    await appointmentRepo.update('t-1', 'a-moved', { scheduledStart: new Date('2026-05-17T10:30:00Z'), scheduledEnd: new Date('2026-05-17T11:30:00Z') });
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: target, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: target.scheduledStart, proposedScheduledEnd: target.scheduledEnd },
      { ...depsWith([], 'tech-1'), assignmentRepo, appointmentRepo },
    );
    expect(r.blocking.some((i) => i.check === 'overlap' && i.conflictingEntityId === 'a-moved')).toBe(true);
  });
});
