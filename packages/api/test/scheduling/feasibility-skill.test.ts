import { describe, it, expect } from 'vitest';
import { checkFeasibility } from '../../src/scheduling/feasibility';
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { SkillMatcher, StubSkillMatcher } from '../../src/scheduling/skill-matcher';
import { HaversineFallbackProvider } from '../../src/scheduling/travel-time/haversine-fallback';
import { Appointment } from '../../src/appointments/appointment';

function appt(): Appointment {
  return {
    id: 'a-1', tenantId: 't-1', jobId: 'j-1',
    scheduledStart: new Date('2026-05-17T10:00:00Z'),
    scheduledEnd: new Date('2026-05-17T11:00:00Z'),
    timezone: 'UTC', status: 'scheduled', holdPendingApproval: false,
    createdBy: 'u-1', createdAt: new Date(), updatedAt: new Date(),
  };
}

function deps(matcher: SkillMatcher): FeasibilityDependencies {
  return {
    assignmentRepo: { findByTechnician: async () => [] } as any,
    appointmentRepo: { findById: async () => null } as any,
    jobRepo: { findById: async () => null } as any,
    locationRepo: { findById: async () => null } as any,
    workingHoursRepo: { findByTechnician: async () => [] } as any,
    unavailableBlockRepo: { findByTechnicianAndDateRange: async () => [] } as any,
    travelTimeProvider: new HaversineFallbackProvider(),
    skillMatcher: matcher,
  };
}

describe('checkFeasibility — skill match sub-check', () => {
  it('produces no issue when StubSkillMatcher is wired (required=[])', async () => {
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt(), proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt().scheduledStart, proposedScheduledEnd: appt().scheduledEnd },
      deps(new StubSkillMatcher()),
    );
    expect(r.warnings.some((w) => w.check === 'skill_match')).toBe(false);
  });

  // Contract #12-#13: "holds required skill if skills are modeled" is a
  // precondition -> blocking (foundation gate F2 term 6).
  it('blocks when the technician is missing a required skill', async () => {
    const matcher: SkillMatcher = {
      requiredSkillsForJob: async () => ['hvac', 'electrical'],
      skillsForTechnician: async () => ['hvac'],
    };
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt(), proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt().scheduledStart, proposedScheduledEnd: appt().scheduledEnd },
      deps(matcher),
    );
    expect(r.feasible).toBe(false);
    const issue = r.blocking.find((w) => w.check === 'skill_match');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('blocking');
    expect((issue?.metadata as any).missingSkills).toEqual(['electrical']);
  });
});
