/**
 * Foundation gate (spec/RIVET_FOUNDATION_SPEC.md) — unit coverage for the
 * availability intersection and its config propagation:
 *
 *  - V15: DST-observing vs non-observing zones, on the 2026 spring-forward
 *    and fall-back dates. Window instants are wall-clock-correct on
 *    transition days (the old fixed-offset-from-midnight math was an hour
 *    off there).
 *  - V17 (unit half): tenant per-day business hours and travel buffer are
 *    consumed by slot generation, not just stored.
 *  - F2 terms: tech working hours clamp windows; tech time-off blocks slots.
 */
import { describe, it, expect } from 'vitest';
import {
  findBookableSlots,
  findBookableSlotsDetailed,
  isWithinBusinessHours,
  hasConfiguredWeeklyHours,
  schedulingConfigFromSettings,
} from '../../src/scheduling/booking-availability';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryAssignmentRepository } from '../../src/appointments/assignment';
import { InMemoryWorkingHoursRepository } from '../../src/availability/working-hours';
import { InMemoryUnavailableBlockRepository } from '../../src/availability/unavailable-block';
import { Appointment } from '../../src/appointments/appointment';

const TENANT = 'tenant-1';
const TECH = 'tech-1';
/** Fixed clock far before every searched window so "never in the past" never trips. */
const NOW = new Date('2026-01-02T00:00:00Z');

function appt(overrides: Partial<Appointment> & { scheduledStart: Date; scheduledEnd: Date }): Appointment {
  return {
    id: overrides.id ?? `appt-${overrides.scheduledStart.toISOString()}`,
    tenantId: TENANT,
    jobId: 'job-1',
    timezone: 'America/New_York',
    status: 'scheduled',
    holdPendingApproval: false,
    ...overrides,
  } as Appointment;
}

function makeDeps() {
  return {
    appointmentRepo: new InMemoryAppointmentRepository(),
    assignmentRepo: new InMemoryAssignmentRepository(),
    workingHoursRepo: new InMemoryWorkingHoursRepository(),
    unavailableBlockRepo: new InMemoryUnavailableBlockRepository(),
  };
}

describe('V15 — DST correctness of business-hour windows', () => {
  it('places the 08:00 open at 12:00Z on the spring-forward day (America/New_York, 2026-03-08)', async () => {
    const deps = makeDeps();
    const slots = await findBookableSlots(deps, {
      tenantId: TENANT,
      fromDate: '2026-03-08',
      toDate: '2026-03-08',
      timezone: 'America/New_York',
      durationMin: 60,
      now: NOW,
    });
    // 08:00 EDT (UTC-4, transition already happened at 02:00) — NOT 13:00Z,
    // which is what midnight(EST)+8h fixed-offset math produces.
    expect(slots[0].start.toISOString()).toBe('2026-03-08T12:00:00.000Z');
  });

  it('places the 08:00 open at 13:00Z on the fall-back day (America/New_York, 2026-11-01)', async () => {
    const deps = makeDeps();
    const slots = await findBookableSlots(deps, {
      tenantId: TENANT,
      fromDate: '2026-11-01',
      toDate: '2026-11-01',
      timezone: 'America/New_York',
      durationMin: 60,
      now: NOW,
    });
    // 08:00 EST (UTC-5, transition at 02:00) — NOT 12:00Z from midnight(EDT)+8h.
    expect(slots[0].start.toISOString()).toBe('2026-11-01T13:00:00.000Z');
  });

  it('keeps America/Phoenix (no DST) at a fixed offset across both transition dates', async () => {
    const deps = makeDeps();
    for (const day of ['2026-03-08', '2026-11-01']) {
      const slots = await findBookableSlots(deps, {
        tenantId: TENANT,
        fromDate: day,
        toDate: day,
        timezone: 'America/Phoenix',
        durationMin: 60,
        now: NOW,
      });
      // 08:00 MST = 15:00Z year-round.
      expect(slots[0].start.toISOString()).toBe(`${day}T15:00:00.000Z`);
    }
  });

  it('control: a non-transition summer day agrees with the fixed-offset math', async () => {
    const deps = makeDeps();
    const slots = await findBookableSlots(deps, {
      tenantId: TENANT,
      fromDate: '2026-06-15',
      toDate: '2026-06-15',
      timezone: 'America/New_York',
      durationMin: 60,
      now: NOW,
    });
    expect(slots[0].start.toISOString()).toBe('2026-06-15T12:00:00.000Z');
  });
});

describe('V17 (unit) — tenant business hours propagate into slot generation', () => {
  it('uses per-day tenant hours and treats a null day as closed', async () => {
    const deps = makeDeps();
    // 2026-06-15 is a Monday, 2026-06-14 a Sunday.
    const weeklyHours = {
      mon: { open: '10:00', close: '12:00' },
      sun: null,
    };
    const monday = await findBookableSlots(deps, {
      tenantId: TENANT,
      fromDate: '2026-06-15',
      toDate: '2026-06-15',
      timezone: 'America/New_York',
      durationMin: 60,
      weeklyHours,
      now: NOW,
      maxSlots: 10,
    });
    expect(monday[0].start.toISOString()).toBe('2026-06-15T14:00:00.000Z'); // 10:00 EDT
    const lastEnd = monday[monday.length - 1].end;
    expect(lastEnd.toISOString() <= '2026-06-15T16:00:00.000Z').toBe(true); // ≤ 12:00 EDT

    const sunday = await findBookableSlots(deps, {
      tenantId: TENANT,
      fromDate: '2026-06-14',
      toDate: '2026-06-14',
      timezone: 'America/New_York',
      durationMin: 60,
      weeklyHours,
      now: NOW,
    });
    expect(sunday).toEqual([]);
  });

  it('a changed business-hours setting changes the offered slots (change-then-observe)', async () => {
    const deps = makeDeps();
    const before = await findBookableSlots(deps, {
      tenantId: TENANT,
      fromDate: '2026-06-15',
      toDate: '2026-06-15',
      timezone: 'America/New_York',
      durationMin: 60,
      weeklyHours: { mon: { open: '08:00', close: '17:00' } },
      now: NOW,
    });
    const after = await findBookableSlots(deps, {
      tenantId: TENANT,
      fromDate: '2026-06-15',
      toDate: '2026-06-15',
      timezone: 'America/New_York',
      durationMin: 60,
      weeklyHours: { mon: { open: '13:00', close: '17:00' } },
      now: NOW,
    });
    expect(before[0].start.toISOString()).toBe('2026-06-15T12:00:00.000Z'); // 08:00 EDT
    expect(after[0].start.toISOString()).toBe('2026-06-15T17:00:00.000Z'); // 13:00 EDT
  });

  it('falls back to the 08:00–17:00 default when weekly hours are empty ({} = not set)', async () => {
    const deps = makeDeps();
    const slots = await findBookableSlots(deps, {
      tenantId: TENANT,
      fromDate: '2026-06-15',
      toDate: '2026-06-15',
      timezone: 'America/New_York',
      durationMin: 60,
      weeklyHours: {},
      now: NOW,
    });
    expect(slots[0].start.toISOString()).toBe('2026-06-15T12:00:00.000Z');
    expect(hasConfiguredWeeklyHours({})).toBe(false);
  });
});

describe('V17 (unit) — travel buffer propagates into slot generation', () => {
  async function slotsWithBuffer(bufferMinutes: number | null) {
    const deps = makeDeps();
    // Busy 12:00–13:00 EDT (16:00–17:00Z) on Monday 2026-06-15.
    await deps.appointmentRepo.create(
      appt({
        scheduledStart: new Date('2026-06-15T16:00:00Z'),
        scheduledEnd: new Date('2026-06-15T17:00:00Z'),
      }),
    );
    return findBookableSlots(deps, {
      tenantId: TENANT,
      fromDate: '2026-06-15',
      toDate: '2026-06-15',
      timezone: 'America/New_York',
      durationMin: 60,
      bufferMinutes,
      now: NOW,
      maxSlots: 20,
    });
  }

  it('tenant buffer of 0 allows back-to-back slots', async () => {
    const starts = (await slotsWithBuffer(0)).map((s) => s.start.toISOString());
    expect(starts).toContain('2026-06-15T15:00:00.000Z'); // 11:00 EDT, butted against 12:00
    expect(starts).toContain('2026-06-15T17:00:00.000Z'); // 13:00 EDT, butted after
  });

  it('tenant buffer of 60 blocks the adjacent hour on both flanks', async () => {
    const starts = (await slotsWithBuffer(60)).map((s) => s.start.toISOString());
    expect(starts).not.toContain('2026-06-15T15:00:00.000Z');
    expect(starts).not.toContain('2026-06-15T17:00:00.000Z');
    expect(starts).toContain('2026-06-15T18:00:00.000Z'); // 14:00 EDT — one hour clear
  });

  it('defaults to the 30-minute buffer when the tenant has not configured one', async () => {
    const { config } = await findBookableSlotsDetailed(makeDeps(), {
      tenantId: TENANT,
      fromDate: '2026-06-15',
      toDate: '2026-06-15',
      timezone: 'America/New_York',
      durationMin: 60,
      now: NOW,
    });
    expect(config.bufferSource).toBe('default');
    expect(config.bufferMinutes).toBe(30);
  });
});

describe('F2 — technician working hours and time-off constrain per-tech slots', () => {
  it('clamps windows to the tech working hours when the tech is modeled', async () => {
    const deps = makeDeps();
    await deps.workingHoursRepo.create({
      id: 'wh-1',
      tenantId: TENANT,
      technicianId: TECH,
      dayOfWeek: 1, // Monday
      startTime: '10:00',
      endTime: '14:00',
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const { slots, config } = await findBookableSlotsDetailed(deps, {
      tenantId: TENANT,
      fromDate: '2026-06-15', // Monday
      toDate: '2026-06-16', // Tuesday — tech not modeled that day → off
      timezone: 'America/New_York',
      durationMin: 60,
      technicianId: TECH,
      now: NOW,
      maxSlots: 20,
    });
    expect(config.technicianHoursApplied).toBe(true);
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      // All slots inside Monday 10:00–14:00 EDT (14:00Z–18:00Z).
      expect(s.start.toISOString() >= '2026-06-15T14:00:00.000Z').toBe(true);
      expect(s.end.toISOString() <= '2026-06-15T18:00:00.000Z').toBe(true);
    }
  });

  it('falls back to business hours when the tech has no working-hours rows', async () => {
    const deps = makeDeps();
    const { slots, config } = await findBookableSlotsDetailed(deps, {
      tenantId: TENANT,
      fromDate: '2026-06-15',
      toDate: '2026-06-15',
      timezone: 'America/New_York',
      durationMin: 60,
      technicianId: TECH,
      now: NOW,
    });
    expect(config.technicianHoursApplied).toBe(false);
    expect(slots[0].start.toISOString()).toBe('2026-06-15T12:00:00.000Z');
  });

  it('subtracts the tech time-off blocks from offered slots', async () => {
    const deps = makeDeps();
    await deps.unavailableBlockRepo.create({
      id: 'blk-1',
      tenantId: TENANT,
      technicianId: TECH,
      startTime: new Date('2026-06-15T12:00:00Z'), // 08:00 EDT
      endTime: new Date('2026-06-15T18:00:00Z'), // 14:00 EDT
      createdBy: 'test',
      createdAt: NOW,
    });
    const { slots, config } = await findBookableSlotsDetailed(deps, {
      tenantId: TENANT,
      fromDate: '2026-06-15',
      toDate: '2026-06-15',
      timezone: 'America/New_York',
      durationMin: 60,
      technicianId: TECH,
      now: NOW,
      maxSlots: 20,
    });
    expect(config.technicianTimeOffApplied).toBe(true);
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect(s.start.toISOString() >= '2026-06-15T18:00:00.000Z').toBe(true);
    }
  });
});

describe('isWithinBusinessHours — write-side twin of slot generation', () => {
  const weekly = { mon: { open: '09:00', close: '15:00' }, sun: null };

  it('accepts a slot inside tenant hours and rejects one outside', () => {
    // Monday 10:00–11:00 EDT
    expect(
      isWithinBusinessHours(
        new Date('2026-06-15T14:00:00Z'),
        new Date('2026-06-15T15:00:00Z'),
        'America/New_York',
        weekly,
      ),
    ).toBe(true);
    // Monday 08:00–09:00 EDT — before open under tenant hours (default would allow it)
    expect(
      isWithinBusinessHours(
        new Date('2026-06-15T12:00:00Z'),
        new Date('2026-06-15T13:00:00Z'),
        'America/New_York',
        weekly,
      ),
    ).toBe(false);
  });

  it('rejects any slot on a closed day', () => {
    // Sunday 10:00–11:00 EDT
    expect(
      isWithinBusinessHours(
        new Date('2026-06-14T14:00:00Z'),
        new Date('2026-06-14T15:00:00Z'),
        'America/New_York',
        weekly,
      ),
    ).toBe(false);
  });

  it('applies the 08:00–17:00 default when the tenant has no configured hours', () => {
    expect(
      isWithinBusinessHours(
        new Date('2026-06-15T12:00:00Z'), // 08:00 EDT
        new Date('2026-06-15T13:00:00Z'),
        'America/New_York',
        null,
      ),
    ).toBe(true);
    expect(
      isWithinBusinessHours(
        new Date('2026-06-15T11:00:00Z'), // 07:00 EDT
        new Date('2026-06-15T12:00:00Z'),
        'America/New_York',
        null,
      ),
    ).toBe(false);
  });
});

describe('schedulingConfigFromSettings — the single settings→scheduling seam', () => {
  it('extracts timezone, weekly hours, and buffer', () => {
    const config = schedulingConfigFromSettings({
      timezone: 'America/Phoenix',
      businessHours: { mon: { open: '07:00', close: '16:00' } },
      jobBufferMinutes: 45,
    } as never);
    expect(config.timezone).toBe('America/Phoenix');
    expect(config.weeklyHours).toEqual({ mon: { open: '07:00', close: '16:00' } });
    expect(config.bufferMinutes).toBe(45);
  });

  it('degrades to nulls for a cold tenant with no settings row', () => {
    const config = schedulingConfigFromSettings(null);
    expect(config).toEqual({ timezone: null, weeklyHours: null, bufferMinutes: null });
  });
});
