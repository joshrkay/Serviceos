import { describe, it, expect } from 'vitest';
import { checkFeasibility } from '../../src/scheduling/feasibility';
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { Appointment } from '../../src/appointments/appointment';
import { StubSkillMatcher } from '../../src/scheduling/skill-matcher';
import { TravelTimeProvider } from '../../src/scheduling/travel-time/provider';
import { HaversineFallbackProvider } from '../../src/scheduling/travel-time/haversine-fallback';

const SF = { latitude: 37.7749, longitude: -122.4194 };
const OAK = { latitude: 37.8044, longitude: -122.2712 };

function mkAppt(over: Partial<Appointment> = {}): Appointment {
  return {
    id: 'a-target', tenantId: 't-1', jobId: 'j-target',
    scheduledStart: new Date('2026-05-17T10:00:00Z'),
    scheduledEnd: new Date('2026-05-17T11:00:00Z'),
    timezone: 'UTC', status: 'scheduled', holdPendingApproval: false,
    createdBy: 'u-1', createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
}

function depsWithNeighbor(opts: {
  neighbor?: Appointment & { locationId?: string };
  targetLocationId?: string;
  locations?: Record<string, { latitude?: number; longitude?: number }>;
  jobs?: Record<string, { locationId?: string }>;
  travelSeconds?: number;
}): FeasibilityDependencies {
  const technicianId = 'tech-1';
  const jobs = opts.jobs ?? {};
  const locations = opts.locations ?? {};
  const provider: TravelTimeProvider = {
    estimateDriveTime: async () => ({ seconds: opts.travelSeconds ?? 0, source: 'haversine', degraded: false }),
  };
  return {
    assignmentRepo: {
      findByTechnician: async () => opts.neighbor
        ? [{ id: 'as-n', tenantId: 't-1', appointmentId: opts.neighbor.id,
             technicianId, isPrimary: true, assignedBy: 'u-1', assignedAt: new Date() }]
        : [],
    } as any,
    appointmentRepo: {
      findById: async (_t: string, id: string) =>
        opts.neighbor && opts.neighbor.id === id ? opts.neighbor : null,
    } as any,
    jobRepo: { findById: async (_t: string, id: string) => jobs[id] ?? null } as any,
    locationRepo: { findById: async (_t: string, id: string) => locations[id] ?? null } as any,
    workingHoursRepo: { findByTechnicianAndDay: async () => null } as any,
    unavailableBlockRepo: { findByTechnicianAndDateRange: async () => [] } as any,
    travelTimeProvider: provider,
    skillMatcher: new StubSkillMatcher(),
  };
}

describe('checkFeasibility — travel-time sub-check', () => {
  it('emits a travel_time warning when the gap to the previous neighbor is shorter than the drive', async () => {
    const target = mkAppt({ jobId: 'j-target' });
    const prev = mkAppt({
      id: 'a-prev', jobId: 'j-prev',
      scheduledStart: new Date('2026-05-17T08:30:00Z'),
      scheduledEnd: new Date('2026-05-17T09:55:00Z'), // 5-min gap before target
    });
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: target, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: target.scheduledStart, proposedScheduledEnd: target.scheduledEnd },
      depsWithNeighbor({
        neighbor: prev,
        jobs: { 'j-target': { locationId: 'L-target' }, 'j-prev': { locationId: 'L-prev' } },
        locations: { 'L-target': SF, 'L-prev': OAK },
        travelSeconds: 1200, // 20 min — does not fit in the 5-min gap
      }),
    );
    expect(r.warnings.some((w) => w.check === 'travel_time')).toBe(true);
    expect(r.travelTime?.fromPrevSeconds).toBe(1200);
  });

  it('emits an info entry (not a warning) when neighbor location coords are missing', async () => {
    const target = mkAppt({ jobId: 'j-target' });
    const prev = mkAppt({
      id: 'a-prev', jobId: 'j-prev',
      scheduledStart: new Date('2026-05-17T08:00:00Z'),
      scheduledEnd: new Date('2026-05-17T09:30:00Z'),
    });
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: target, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: target.scheduledStart, proposedScheduledEnd: target.scheduledEnd },
      depsWithNeighbor({
        neighbor: prev,
        jobs: { 'j-target': { locationId: 'L-target' }, 'j-prev': { locationId: 'L-prev' } },
        locations: { 'L-target': SF, 'L-prev': { latitude: undefined, longitude: undefined } },
        travelSeconds: 99999,
      }),
    );
    expect(r.warnings.some((w) => w.check === 'travel_time')).toBe(false);
    expect(r.info.some((i) => i.check === 'travel_time' && (i.metadata as any)?.reason === 'missing_coords')).toBe(true);
  });

  it('returns travelTime null when there are no neighbors', async () => {
    const target = mkAppt({ jobId: 'j-target' });
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: target, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: target.scheduledStart, proposedScheduledEnd: target.scheduledEnd },
      depsWithNeighbor({
        jobs: { 'j-target': { locationId: 'L-target' } },
        locations: { 'L-target': SF },
      }),
    );
    expect(r.travelTime).toEqual({
      fromPrevSeconds: null, toNextSeconds: null,
      estimateSource: 'unknown', degraded: false,
    });
  });

  it('uses a [start-24h, end+24h] window so cross-midnight neighbors are considered', async () => {
    const target = mkAppt({
      scheduledStart: new Date('2026-05-17T23:30:00Z'),
      scheduledEnd: new Date('2026-05-18T00:30:00Z'),
    });
    const next = mkAppt({
      id: 'a-next', jobId: 'j-next',
      scheduledStart: new Date('2026-05-18T00:35:00Z'),
      scheduledEnd: new Date('2026-05-18T01:30:00Z'),
    });
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: target, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: target.scheduledStart, proposedScheduledEnd: target.scheduledEnd },
      depsWithNeighbor({
        neighbor: next,
        jobs: { 'j-target': { locationId: 'L-target' }, 'j-next': { locationId: 'L-next' } },
        locations: { 'L-target': SF, 'L-next': OAK },
        travelSeconds: 900, // 15-min drive vs. 5-min gap
      }),
    );
    expect(r.warnings.some((w) => w.check === 'travel_time')).toBe(true);
    expect(r.travelTime?.toNextSeconds).toBe(900);
  });
});
