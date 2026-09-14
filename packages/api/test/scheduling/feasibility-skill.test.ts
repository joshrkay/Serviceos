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

/**
 * 4.9 / issue #1001 — "the whole file is nine lines returning `[]`, and it is
 * wired into `checkFeasibility`, so an empty skill list reads as 'always
 * feasible'". These pin the fix: the outcome NAMES why the skill gate was
 * clean instead of staying silent about it. No skills-based assignment is
 * built here — only the honesty of the report.
 */
describe('checkFeasibility — skill-constraint outcome is explicit, never silent (4.9 / #1001)', () => {
  it("reports skillConstraints: 'none_configured' when the job models no required skills", async () => {
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt(), proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt().scheduledStart, proposedScheduledEnd: appt().scheduledEnd },
      deps(new StubSkillMatcher()),
    );
    // Feasible, yes — but the report says WHY the skill gate was clean.
    expect(r.feasible).toBe(true);
    expect(r.skillConstraints).toBe('none_configured');
  });

  it("reports skillConstraints: 'evaluated' when required skills exist and the technician holds them", async () => {
    const matcher: SkillMatcher = {
      requiredSkillsForJob: async () => ['hvac'],
      skillsForTechnician: async () => ['hvac', 'electrical'],
    };
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt(), proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt().scheduledStart, proposedScheduledEnd: appt().scheduledEnd },
      deps(matcher),
    );
    expect(r.feasible).toBe(true);
    expect(r.skillConstraints).toBe('evaluated');
  });

  it("reports skillConstraints: 'evaluated' when a required skill is missing (the blocking case)", async () => {
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
    expect(r.skillConstraints).toBe('evaluated');
  });

  it("reports skillConstraints: 'not_evaluated' when there is no technician to check (the gate never ran)", async () => {
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt(), proposedTechnicianId: undefined,
        proposedScheduledStart: appt().scheduledStart, proposedScheduledEnd: appt().scheduledEnd },
      deps(new StubSkillMatcher()),
    );
    // #909/A11: no assigned technician is not a blocking conflict — but the
    // report must not claim the skill gate passed either.
    expect(r.feasible).toBe(true);
    expect(r.skillConstraints).toBe('not_evaluated');
  });

  it('T2 — a second tenant with a DIFFERENT skill model gets its own outcome, not tenant A\'s', async () => {
    // Tenant A models nothing; tenant B models a skill its technician lacks.
    const perTenant: SkillMatcher = {
      requiredSkillsForJob: async (tenantId: string) => (tenantId === 't-2' ? ['gas_fitting'] : []),
      skillsForTechnician: async (tenantId: string) => (tenantId === 't-2' ? ['hvac'] : []),
    };
    const a = await checkFeasibility(
      { tenantId: 't-1', appointment: appt(), proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt().scheduledStart, proposedScheduledEnd: appt().scheduledEnd },
      deps(perTenant),
    );
    const apptB = { ...appt(), tenantId: 't-2' };
    const b = await checkFeasibility(
      { tenantId: 't-2', appointment: apptB, proposedTechnicianId: 'tech-2',
        proposedScheduledStart: apptB.scheduledStart, proposedScheduledEnd: apptB.scheduledEnd },
      deps(perTenant),
    );
    expect(a.skillConstraints).toBe('none_configured');
    expect(a.feasible).toBe(true);
    expect(b.skillConstraints).toBe('evaluated');
    expect(b.feasible).toBe(false);
  });
});
