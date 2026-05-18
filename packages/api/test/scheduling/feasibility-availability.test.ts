import { describe, it, expect } from 'vitest';
import { checkFeasibility } from '../../src/scheduling/feasibility';
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { Appointment } from '../../src/appointments/appointment';
import { StubSkillMatcher } from '../../src/scheduling/skill-matcher';
import { HaversineFallbackProvider } from '../../src/scheduling/travel-time/haversine-fallback';

function mkAppt(): Appointment {
  return {
    id: 'a-1', tenantId: 't-1', jobId: 'j-1',
    scheduledStart: new Date('2026-05-17T19:00:00Z'), // 12:00 PT
    scheduledEnd: new Date('2026-05-17T20:00:00Z'),
    timezone: 'America/Los_Angeles', status: 'scheduled',
    holdPendingApproval: false,
    createdBy: 'u-1', createdAt: new Date(), updatedAt: new Date(),
  };
}

function deps(workingHours: any, unavailableBlocks: any[] = []): FeasibilityDependencies {
  return {
    assignmentRepo: { findByTechnician: async () => [] } as any,
    appointmentRepo: { findById: async () => null } as any,
    jobRepo: { findById: async () => null } as any,
    locationRepo: { findById: async () => null } as any,
    workingHoursRepo: { findByTechnicianAndDay: async () => workingHours } as any,
    unavailableBlockRepo: { findByTechnicianAndDateRange: async () => unavailableBlocks } as any,
    travelTimeProvider: new HaversineFallbackProvider(),
    skillMatcher: new StubSkillMatcher(),
    timezone: 'America/Los_Angeles',
  };
}

describe('checkFeasibility — availability sub-check', () => {
  it('emits a working-hours warning when the proposal is outside hours', async () => {
    const appt = mkAppt(); // 12:00–13:00 PT
    const wh = { id: 'wh', tenantId: 't-1', technicianId: 'tech-1',
                 dayOfWeek: 0, startTime: '14:00', endTime: '17:00', isActive: true,
                 createdAt: new Date(), updatedAt: new Date() };
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt.scheduledStart, proposedScheduledEnd: appt.scheduledEnd },
      deps(wh),
    );
    expect(r.feasible).toBe(true);                  // warning, not blocking
    expect(r.warnings.some((w) => w.check === 'working_hours')).toBe(true);
  });

  it('emits an unavailable-block warning when the proposal overlaps a block', async () => {
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
      deps(null, blocks),
    );
    expect(r.feasible).toBe(true);
    expect(r.warnings.some((w) => w.check === 'unavailable_block')).toBe(true);
  });
});
