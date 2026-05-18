import { describe, it, expect } from 'vitest';
import { checkFeasibility } from '../../src/scheduling/feasibility';
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { Appointment } from '../../src/appointments/appointment';
import { StubSkillMatcher } from '../../src/scheduling/skill-matcher';
import { HaversineFallbackProvider } from '../../src/scheduling/travel-time/haversine-fallback';

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
    workingHoursRepo: { findByTechnicianAndDay: async () => null } as any,
    unavailableBlockRepo: { findByTechnicianInRange: async () => [] } as any,
    travelTimeProvider: new HaversineFallbackProvider(),
    skillMatcher: new StubSkillMatcher(),
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
