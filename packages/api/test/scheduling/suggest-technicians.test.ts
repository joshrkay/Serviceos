import { describe, it, expect } from 'vitest';
import {
  MAX_SUGGESTION_CANDIDATES,
  overlapMinutes,
  TechnicianSuggestion,
  rankSuggestions,
  suggestTechnicians,
  technicianDisplayName,
  toSuggestion,
} from '../../src/scheduling/suggest-technicians';
import { FeasibilityDependencies, FeasibilityResult } from '../../src/scheduling/feasibility-types';
import { SkillMatcher } from '../../src/scheduling/skill-matcher';
import { HaversineFallbackProvider } from '../../src/scheduling/travel-time/haversine-fallback';
import { Appointment } from '../../src/appointments/appointment';
import { User } from '../../src/users/user';

const s = (over: Partial<TechnicianSuggestion>): TechnicianSuggestion => ({
  technicianId: 't', name: 'T', feasible: true, reasons: [], warningCount: 0,
  travelFromPrevSeconds: null, travelEstimateSource: null, isCurrent: false, overlaps: [],
  ...over,
});

const appt = (over: Partial<Appointment> = {}): Appointment => ({
  id: 'a-1', tenantId: 't-1', jobId: 'j-1',
  scheduledStart: new Date('2026-05-17T10:00:00Z'),
  scheduledEnd: new Date('2026-05-17T11:00:00Z'),
  timezone: 'UTC', status: 'scheduled', holdPendingApproval: false,
  createdBy: 'u-1', createdAt: new Date(), updatedAt: new Date(),
  ...over,
});

const user = (id: string, over: Partial<User> = {}): User => ({
  id, tenantId: 't-1', email: `${id}@x.test`, role: 'technician', firstName: id,
  canFieldServe: false, createdAt: new Date(), updatedAt: new Date(),
  ...over,
});

function deps(over: Partial<FeasibilityDependencies> = {}): FeasibilityDependencies {
  return {
    assignmentRepo: { findByTechnician: async () => [] } as any,
    appointmentRepo: { findById: async () => null } as any,
    jobRepo: { findById: async () => null } as any,
    locationRepo: { findById: async () => null } as any,
    workingHoursRepo: { findByTechnician: async () => [] } as any,
    unavailableBlockRepo: { findByTechnicianAndDateRange: async () => [] } as any,
    travelTimeProvider: new HaversineFallbackProvider(),
    skillMatcher: { requiredSkillsForJob: async () => [], skillsForTechnician: async () => [] },
    ...over,
  };
}

describe('rankSuggestions', () => {
  it('puts feasible techs before infeasible ones, even when the infeasible one is closer', () => {
    const ranked = rankSuggestions([
      s({ technicianId: 'near-blocked', feasible: false, travelFromPrevSeconds: 60 }),
      s({ technicianId: 'far-ok', travelFromPrevSeconds: 3600 }),
    ]);
    expect(ranked.map((r) => r.technicianId)).toEqual(['far-ok', 'near-blocked']);
  });

  it('orders known drives shortest first, and unknown drives after every known one', () => {
    const ranked = rankSuggestions([
      s({ technicianId: 'unknown', name: 'A' }),
      s({ technicianId: 'far', travelFromPrevSeconds: 1800 }),
      s({ technicianId: 'near', travelFromPrevSeconds: 300 }),
    ]);
    expect(ranked.map((r) => r.technicianId)).toEqual(['near', 'far', 'unknown']);
  });

  it('breaks ties on fewer warnings, then name', () => {
    const ranked = rankSuggestions([
      s({ technicianId: 'zed', name: 'Zed' }),
      s({ technicianId: 'warned', name: 'Ann', warningCount: 1 }),
      s({ technicianId: 'amy', name: 'Amy' }),
    ]);
    expect(ranked.map((r) => r.technicianId)).toEqual(['amy', 'zed', 'warned']);
  });

  it('does not mutate its input', () => {
    const input = [s({ technicianId: 'b', name: 'B' }), s({ technicianId: 'a', name: 'A' })];
    rankSuggestions(input);
    expect(input.map((r) => r.technicianId)).toEqual(['b', 'a']);
  });
});

describe('technicianDisplayName', () => {
  it('joins first and last name, falling back to email', () => {
    expect(technicianDisplayName({ firstName: 'Ada', lastName: 'Lee', email: 'a@x' })).toBe('Ada Lee');
    expect(technicianDisplayName({ firstName: 'Ada', email: 'a@x' })).toBe('Ada');
    expect(technicianDisplayName({ firstName: ' ', email: 'a@x' })).toBe('a@x');
  });
});

describe('overlapMinutes', () => {
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 4, 17, h, m));
  it('counts shared minutes, zero when the windows only touch or are apart', () => {
    expect(overlapMinutes({ start: at(10), end: at(11) }, { start: at(10, 30), end: at(12) })).toBe(30);
    expect(overlapMinutes({ start: at(10), end: at(11) }, { start: at(9), end: at(12) })).toBe(60);
    expect(overlapMinutes({ start: at(10), end: at(11) }, { start: at(11), end: at(12) })).toBe(0);
    expect(overlapMinutes({ start: at(10), end: at(11) }, { start: at(13), end: at(14) })).toBe(0);
  });
});

describe('toSuggestion', () => {
  it('lists blocking reasons before warnings and carries the drive', () => {
    const result: FeasibilityResult = {
      feasible: false,
      blocking: [{ check: 'overlap', severity: 'blocking', message: 'Overlaps' }],
      warnings: [{ check: 'travel_time', severity: 'warning', message: 'Tight drive' }],
      info: [],
      travelTime: { fromPrevSeconds: 900, toNextSeconds: null, estimateSource: 'google', degraded: false },
      skillConstraints: 'none_configured',
    };
    expect(toSuggestion(user('t1'), result, true)).toEqual({
      technicianId: 't1', name: 't1', feasible: false, reasons: ['Overlaps', 'Tight drive'],
      warningCount: 1, travelFromPrevSeconds: 900, travelEstimateSource: 'google', isCurrent: true,
      overlaps: [],
    });
  });
});

describe('suggestTechnicians', () => {
  it('ranks a qualified tech above one missing a required skill', async () => {
    const matcher: SkillMatcher = {
      requiredSkillsForJob: async () => ['hvac'],
      skillsForTechnician: async (_t, id) => (id === 'qualified' ? ['hvac'] : []),
    };
    const out = await suggestTechnicians(deps({ skillMatcher: matcher }), {
      tenantId: 't-1', appointment: appt(),
      candidates: [user('unqualified', { firstName: 'Aaron' }), user('qualified', { firstName: 'Zoe' })],
    });
    expect(out.map((r) => [r.technicianId, r.feasible])).toEqual([['qualified', true], ['unqualified', false]]);
    expect(out[1].reasons.join(' ')).toMatch(/hvac/);
  });

  it('flags a tech already booked over the window as infeasible, with the clashing times', async () => {
    const other = appt({
      id: 'a-other', jobId: 'j-other',
      scheduledStart: new Date('2026-05-17T09:30:00Z'),
      scheduledEnd: new Date('2026-05-17T10:30:00Z'),
    });
    const out = await suggestTechnicians(
      deps({
        assignmentRepo: {
          findByTechnician: async (_t: string, id: string) =>
            id === 'busy' ? [{ appointmentId: 'a-other', technicianId: 'busy', isPrimary: true }] : [],
        } as any,
        appointmentRepo: { findById: async (_t: string, id: string) => (id === 'a-other' ? other : null) } as any,
        jobRepo: { findById: async (_t: string, id: string) => (id === 'j-other' ? { summary: 'Boiler service' } : null) } as any,
      }),
      { tenantId: 't-1', appointment: appt(), candidates: [user('busy', { firstName: 'Al' }), user('free', { firstName: 'Bo' })] },
    );
    expect(out.map((r) => [r.technicianId, r.feasible])).toEqual([['free', true], ['busy', false]]);
    expect(out[1].overlaps).toEqual([{
      appointmentId: 'a-other', jobSummary: 'Boiler service',
      scheduledStart: '2026-05-17T09:30:00.000Z', scheduledEnd: '2026-05-17T10:30:00.000Z', overlapMinutes: 30,
    }]);
    expect(out[0].overlaps).toEqual([]);
  });

  it('skips non-technicians and inactive members, and marks the current assignee', async () => {
    const out = await suggestTechnicians(deps(), {
      tenantId: 't-1', appointment: appt(), currentTechnicianId: 'cur',
      candidates: [
        user('cur'),
        user('disp', { role: 'dispatcher' }),
        user('gone', { deletedAt: new Date() }),
        user('susp', { status: 'suspended' }),
      ],
    });
    expect(out.map((r) => r.technicianId)).toEqual(['cur']);
    expect(out[0].isCurrent).toBe(true);
  });

  it('checks at most MAX_SUGGESTION_CANDIDATES technicians', async () => {
    const candidates = Array.from({ length: MAX_SUGGESTION_CANDIDATES + 5 }, (_, i) => user(`t${i}`));
    const out = await suggestTechnicians(deps(), { tenantId: 't-1', appointment: appt(), candidates });
    expect(out).toHaveLength(MAX_SUGGESTION_CANDIDATES);
  });
});
