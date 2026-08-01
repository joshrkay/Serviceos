import { describe, it, expect } from 'vitest';
import { checkFeasibility } from '../../src/scheduling/feasibility';
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { Appointment } from '../../src/appointments/appointment';
import { StubSkillMatcher } from '../../src/scheduling/skill-matcher';
import { HaversineFallbackProvider } from '../../src/scheduling/travel-time/haversine-fallback';

function mkAppt(): Appointment {
  return {
    id: 'a-1', tenantId: 't-1', jobId: 'j-1',
    scheduledStart: new Date('2026-05-17T19:00:00Z'), // Sunday 12:00 PT
    scheduledEnd: new Date('2026-05-17T20:00:00Z'),
    timezone: 'America/Los_Angeles', status: 'scheduled',
    holdPendingApproval: false,
    createdBy: 'u-1', createdAt: new Date(), updatedAt: new Date(),
  };
}

function deps(workingHoursRows: any[], unavailableBlocks: any[] = []): FeasibilityDependencies {
  return {
    assignmentRepo: { findByTechnician: async () => [] } as any,
    appointmentRepo: { findById: async () => null } as any,
    jobRepo: { findById: async () => null } as any,
    locationRepo: { findById: async () => null } as any,
    workingHoursRepo: { findByTechnician: async () => workingHoursRows } as any,
    unavailableBlockRepo: { findByTechnicianAndDateRange: async () => unavailableBlocks } as any,
    travelTimeProvider: new HaversineFallbackProvider(),
    skillMatcher: new StubSkillMatcher(),
    timezone: 'America/Los_Angeles',
  };
}

function whRow(dayOfWeek: number, startTime: string, endTime: string) {
  return {
    id: `wh-${dayOfWeek}`, tenantId: 't-1', technicianId: 'tech-1',
    dayOfWeek, startTime, endTime, isActive: true,
    createdAt: new Date(), updatedAt: new Date(),
  };
}

describe('checkFeasibility — availability sub-check', () => {
  // Contract #12/#13 ("tech available for full window") makes working-hours
  // and time-off violations BLOCKING, not advisory (foundation gate F2).

  it('blocks when the proposal is outside the modeled working hours', async () => {
    const appt = mkAppt(); // Sunday 12:00–13:00 PT
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt.scheduledStart, proposedScheduledEnd: appt.scheduledEnd },
      deps([whRow(0, '14:00', '17:00')]), // Sunday 14:00–17:00 — proposal is before open
    );
    expect(r.feasible).toBe(false);
    expect(r.blocking.some((w) => w.check === 'working_hours')).toBe(true);
  });

  it('is feasible when the proposal fits inside the modeled hours', async () => {
    const appt = mkAppt(); // Sunday 12:00–13:00 PT
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt.scheduledStart, proposedScheduledEnd: appt.scheduledEnd },
      deps([whRow(0, '08:00', '17:00')]),
    );
    expect(r.feasible).toBe(true);
    expect(r.blocking).toHaveLength(0);
  });

  it('is unconstrained when the technician has no working-hours rows at all', async () => {
    const appt = mkAppt();
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt.scheduledStart, proposedScheduledEnd: appt.scheduledEnd },
      deps([]),
    );
    expect(r.feasible).toBe(true);
    expect(r.blocking).toHaveLength(0);
  });

  it('blocks a modeled-but-off-day proposal (rows exist, none for this weekday)', async () => {
    const appt = mkAppt(); // Sunday PT
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt.scheduledStart, proposedScheduledEnd: appt.scheduledEnd },
      deps([whRow(1, '08:00', '17:00')]), // Monday-only tech, Sunday proposal
    );
    expect(r.feasible).toBe(false);
    expect(r.blocking.some((w) => w.check === 'working_hours')).toBe(true);
  });

  it('resolves the weekday in the technician timezone, not UTC', async () => {
    // 2026-05-18T02:00Z is Monday in UTC but Sunday 19:00 in America/Los_Angeles.
    // A Sunday-only tech must therefore be considered ON duty (no off-day
    // block); a UTC-weekday resolution would look up Monday and block.
    const appt: Appointment = {
      ...mkAppt(),
      scheduledStart: new Date('2026-05-18T02:00:00Z'),
      scheduledEnd: new Date('2026-05-18T03:00:00Z'),
    };
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt.scheduledStart, proposedScheduledEnd: appt.scheduledEnd },
      deps([whRow(0, '08:00', '23:00')]), // Sunday-only
    );
    expect(r.feasible).toBe(true);
    expect(r.blocking).toHaveLength(0);
  });

  it('blocks when the proposal overlaps a time-off block', async () => {
    const appt = mkAppt();
    const blocks = [{
      id: 'b-1', tenantId: 't-1', technicianId: 'tech-1',
      startTime: new Date('2026-05-17T19:30:00Z'),
      endTime: new Date('2026-05-17T20:30:00Z'),
      reason: 'PTO', createdAt: new Date(), updatedAt: new Date(),
    }];
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt.scheduledStart, proposedScheduledEnd: appt.scheduledEnd },
      deps([], blocks),
    );
    expect(r.feasible).toBe(false);
    expect(r.blocking.some((w) => w.check === 'unavailable_block')).toBe(true);
  });
});
