/**
 * Task 10 (2026-08-07 tradesperson plan) — `lookupCrewSchedule` skill tests.
 *
 * Owner/dispatcher asks who is free / where a named crew member is, on a
 * given day or window. Mirrors lookup-day-overview.test.ts's fixture
 * pattern (InMemory repos, no gateway — deterministic composition over
 * tenant data). Covers: found/none/error, record() on all three,
 * technician-scoped vs whole-crew answers, and day resolution (named day,
 * unparseable phrase falling back to today, absent phrase defaulting to
 * today).
 */
import { describe, it, expect, vi } from 'vitest';
import { lookupCrewSchedule } from '../../../src/ai/skills/lookup-crew-schedule';
import { InMemoryAppointmentRepository } from '../../../src/appointments/in-memory-appointment';
import type { Appointment } from '../../../src/appointments/appointment';
import { InMemoryJobRepository, Job } from '../../../src/jobs/job';
import { InMemoryUserRepository } from '../../../src/users/user';
import type { LookupEventService } from '../../../src/lookup-events/lookup-event-service';

const TENANT = 'tenant-1';
const TZ = 'America/New_York';
// 2026-06-11 (Thursday) ~07:00 New York (11:00 UTC).
const NOW = new Date('2026-06-11T11:00:00.000Z');

function makeJob(over: Partial<Job>): Job {
  return {
    id: `job-${Math.random().toString(36).slice(2, 8)}`,
    tenantId: TENANT,
    customerId: 'cust-1',
    locationId: 'loc-1',
    jobNumber: 'JOB-0001',
    summary: 'Water heater replacement',
    status: 'scheduled',
    priority: 'normal',
    createdBy: 'u1',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    ...over,
  } as Job;
}

function makeAppointment(over: Partial<Appointment>): Appointment {
  return {
    id: `appt-${Math.random().toString(36).slice(2, 8)}`,
    tenantId: TENANT,
    jobId: 'job-1',
    scheduledStart: new Date('2026-06-11T13:00:00.000Z'), // 9am NY
    scheduledEnd: new Date('2026-06-11T15:00:00.000Z'),
    timezone: TZ,
    status: 'scheduled',
    holdPendingApproval: false,
    createdBy: 'u1',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    ...over,
  };
}

function eventsSpy(): LookupEventService {
  return { record: vi.fn(async () => ({}) as never) } as unknown as LookupEventService;
}

interface FixtureOpts {
  appointments?: Appointment[];
  jobs?: Job[];
  technicians?: Array<{
    id: string;
    firstName: string;
    lastName: string;
    role?: 'technician' | 'dispatcher' | 'owner';
  }>;
}

async function fixtures(opts: FixtureOpts = {}) {
  const appointmentRepo = new InMemoryAppointmentRepository();
  const jobRepo = new InMemoryJobRepository();
  const userRepo = new InMemoryUserRepository();
  for (const a of opts.appointments ?? []) await appointmentRepo.create(a);
  for (const j of opts.jobs ?? []) await jobRepo.create(j);
  for (const t of opts.technicians ?? []) {
    await userRepo.create({
      id: t.id,
      tenantId: TENANT,
      email: `${t.id}@example.com`,
      role: t.role ?? 'technician',
      firstName: t.firstName,
      lastName: t.lastName,
      canFieldServe: true,
    });
  }
  return { appointmentRepo, jobRepo, userRepo };
}

describe('lookupCrewSchedule skill', () => {
  it('reports who is free and who is booked for the whole crew (no technician named)', async () => {
    const jobMike = makeJob({ id: 'job-mike', summary: 'AC tune-up', assignedTechnicianId: 'tech-mike' });
    const deps = await fixtures({
      jobs: [jobMike],
      appointments: [
        makeAppointment({ id: 'appt-mike', jobId: 'job-mike' }),
      ],
      technicians: [
        { id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' },
        { id: 'tech-carlos', firstName: 'Carlos', lastName: 'Ruiz' },
      ],
    });

    const res = await lookupCrewSchedule({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.freeTechnicians).toEqual(['Carlos Ruiz']);
    expect(res.data.bookings.map((b) => b.technicianName)).toEqual(['Mike Diaz']);
    expect(res.summary).toContain('Carlos Ruiz');
    expect(res.summary).toContain('Mike Diaz');
  });

  it('scopes to ONE technician when technicianId is resolved — never the whole crew', async () => {
    const jobMike = makeJob({ id: 'job-mike', summary: 'AC tune-up', assignedTechnicianId: 'tech-mike' });
    const deps = await fixtures({
      jobs: [jobMike],
      appointments: [makeAppointment({ id: 'appt-mike', jobId: 'job-mike' })],
      technicians: [
        { id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' },
        { id: 'tech-carlos', firstName: 'Carlos', lastName: 'Ruiz' },
      ],
    });

    const res = await lookupCrewSchedule(
      { tenantId: TENANT, timezone: TZ, now: NOW, technicianId: 'tech-mike' },
      deps,
    );

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    // Only Mike's booking — Carlos never appears anywhere in the answer.
    expect(res.data.bookings.every((b) => b.technicianName === 'Mike Diaz')).toBe(true);
    expect(res.summary).toContain('Mike Diaz');
    expect(res.summary).not.toContain('Carlos');
  });

  it('a named technician with nothing booked reports free-all-day for THAT person only', async () => {
    const deps = await fixtures({
      technicians: [
        { id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' },
        { id: 'tech-carlos', firstName: 'Carlos', lastName: 'Ruiz' },
      ],
    });

    const res = await lookupCrewSchedule(
      { tenantId: TENANT, timezone: TZ, now: NOW, technicianId: 'tech-carlos' },
      deps,
    );

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.bookings).toEqual([]);
    expect(res.summary).toContain('Carlos Ruiz');
    expect(res.summary).toMatch(/free/i);
  });

  it('resolves a named day ("Thursday afternoon" style phrase) rather than defaulting to today', async () => {
    // NOW is Thursday 2026-06-11. A job booked NEXT Thursday (2026-06-18)
    // must not show up when asking about "today" implicitly, and a
    // dateTimeDescription resolving to that day must surface it.
    const jobNextThu = makeJob({ id: 'job-next-thu', summary: 'Drain cleaning', assignedTechnicianId: 'tech-mike' });
    const deps = await fixtures({
      jobs: [jobNextThu],
      appointments: [
        makeAppointment({
          id: 'appt-next-thu',
          jobId: 'job-next-thu',
          scheduledStart: new Date('2026-06-18T16:00:00.000Z'), // ~noon NY next Thursday
          scheduledEnd: new Date('2026-06-18T18:00:00.000Z'),
        }),
      ],
      technicians: [{ id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' }],
    });

    const today = await lookupCrewSchedule({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);
    expect(today.status).toBe('found');
    if (today.status !== 'found') throw new Error('unreachable');
    expect(today.data.bookings).toEqual([]);

    const nextThu = await lookupCrewSchedule(
      { tenantId: TENANT, timezone: TZ, now: NOW, dateTimeDescription: 'next Thursday afternoon' },
      deps,
    );
    expect(nextThu.status).toBe('found');
    if (nextThu.status !== 'found') throw new Error('unreachable');
    expect(nextThu.data.bookings.map((b) => b.technicianName)).toEqual(['Mike Diaz']);
  });

  it('an unparseable day phrase falls back to today and is honest about it in the summary', async () => {
    const deps = await fixtures({ technicians: [{ id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' }] });

    const res = await lookupCrewSchedule(
      { tenantId: TENANT, timezone: TZ, now: NOW, dateTimeDescription: 'gibberish not a date' },
      deps,
    );

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.dayLabel).toBe('today');
    expect(res.summary).toContain('today');
  });

  // Quality-review C1 — the exact bug: resolveDateTime (the booking
  // resolver) REFUSES a bare day with no time-of-day ('ambiguous_no_time'),
  // so "tomorrow"/"Monday"/"this Friday"/"next week" used to silently fall
  // through to TODAY. resolveSpokenDay must accept all of them.
  describe('C1 — bare-day phrases resolve to the ACTUAL day, never a silent today-fallback', () => {
    it('"tomorrow" (bare, no time-of-day) resolves to tomorrow, not today', async () => {
      const jobTomorrow = makeJob({ id: 'job-tmrw', assignedTechnicianId: 'tech-mike' });
      const deps = await fixtures({
        jobs: [jobTomorrow],
        appointments: [
          makeAppointment({
            id: 'appt-tmrw',
            jobId: 'job-tmrw',
            scheduledStart: new Date('2026-06-12T13:00:00.000Z'), // 9am NY, tomorrow
            scheduledEnd: new Date('2026-06-12T14:00:00.000Z'),
          }),
        ],
        technicians: [{ id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' }],
      });

      const today = await lookupCrewSchedule({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);
      expect(today.status).toBe('found');
      if (today.status !== 'found') throw new Error('unreachable');
      expect(today.data.bookings).toEqual([]); // tomorrow's job must not show today

      const tomorrow = await lookupCrewSchedule(
        { tenantId: TENANT, timezone: TZ, now: NOW, dateTimeDescription: 'tomorrow' },
        deps,
      );
      expect(tomorrow.status).toBe('found');
      if (tomorrow.status !== 'found') throw new Error('unreachable');
      expect(tomorrow.data.dayLabel).not.toBe('today');
      expect(tomorrow.data.bookings.map((b) => b.technicianName)).toEqual(['Mike Diaz']);
    });

    it('"Monday" (bare weekday) resolves forward to the next Monday, not today', async () => {
      // NOW is Thursday 2026-06-11; the next Monday is 2026-06-15.
      const jobMonday = makeJob({ id: 'job-mon', assignedTechnicianId: 'tech-mike' });
      const deps = await fixtures({
        jobs: [jobMonday],
        appointments: [
          makeAppointment({
            id: 'appt-mon',
            jobId: 'job-mon',
            scheduledStart: new Date('2026-06-15T13:00:00.000Z'),
            scheduledEnd: new Date('2026-06-15T14:00:00.000Z'),
          }),
        ],
        technicians: [{ id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' }],
      });

      const res = await lookupCrewSchedule(
        { tenantId: TENANT, timezone: TZ, now: NOW, dateTimeDescription: 'Monday' },
        deps,
      );
      expect(res.status).toBe('found');
      if (res.status !== 'found') throw new Error('unreachable');
      expect(res.data.dayLabel).not.toBe('today');
      expect(res.data.bookings.map((b) => b.technicianName)).toEqual(['Mike Diaz']);
    });

    it('"this Friday" and "next week" both resolve away from today (never ambiguous_no_time-fallback)', async () => {
      const deps = await fixtures({ technicians: [{ id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' }] });

      for (const phrase of ['this Friday', 'next week']) {
        const res = await lookupCrewSchedule(
          { tenantId: TENANT, timezone: TZ, now: NOW, dateTimeDescription: phrase },
          deps,
        );
        expect(res.status).toBe('found');
        if (res.status !== 'found') throw new Error('unreachable');
        expect(res.data.dayLabel).not.toBe('today');
      }
    });
  });

  // Quality-review C2 — a job created long before MAX_JOB_LIMIT more-recent
  // jobs, with a real appointment TODAY, must still be found — never
  // dropped because it fell off a createdAt-DESC page.
  it('C2 — a job outside a recency-limited page with an appointment today is still counted as busy', async () => {
    const oldJob = makeJob({
      id: 'job-old',
      assignedTechnicianId: 'tech-mike',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const deps = await fixtures({
      jobs: [oldJob],
      appointments: [makeAppointment({ id: 'appt-old', jobId: 'job-old' })],
      technicians: [{ id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' }],
    });
    // Bury the old job behind 250 more-recently-created jobs.
    const newerBase = new Date('2026-06-10T00:00:00.000Z').getTime();
    for (let i = 0; i < 250; i++) {
      await deps.jobRepo.create(
        makeJob({ id: `job-new-${i}`, createdAt: new Date(newerBase + i * 1000) }),
      );
    }

    const res = await lookupCrewSchedule({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.bookings.map((b) => b.technicianName)).toEqual(['Mike Diaz']);
    expect(res.data.freeTechnicians).toEqual([]);
    expect(res.summary).not.toContain('free all day');
  });

  // Spec-review MEDIUM — the entity resolver's `technician` EntityKind
  // matches role IN ('technician','dispatcher','owner'), so a working
  // dispatcher or owner resolves fine by name. The roster query must
  // accept the SAME three roles, or a real booking silently vanishes and
  // the person is reported "free all day" under the fallback name.
  it('MEDIUM — a working DISPATCHER shows as busy under their real name, never "free all day"', async () => {
    const jobDispatcher = makeJob({ id: 'job-disp', assignedTechnicianId: 'disp-jane' });
    const deps = await fixtures({
      jobs: [jobDispatcher],
      appointments: [makeAppointment({ id: 'appt-disp', jobId: 'job-disp' })],
      technicians: [{ id: 'disp-jane', firstName: 'Jane', lastName: 'Ortiz', role: 'dispatcher' }],
    });

    const res = await lookupCrewSchedule(
      { tenantId: TENANT, timezone: TZ, now: NOW, technicianId: 'disp-jane' },
      deps,
    );

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.summary).toContain('Jane Ortiz');
    expect(res.summary).not.toContain('that technician');
    expect(res.summary).not.toContain('free all day');
    expect(res.data.bookings.map((b) => b.technicianName)).toEqual(['Jane Ortiz']);
  });

  it('MEDIUM — a working OWNER appears in the whole-crew "Booked" list, not the free list', async () => {
    const jobOwner = makeJob({ id: 'job-owner', assignedTechnicianId: 'owner-bob' });
    const deps = await fixtures({
      jobs: [jobOwner],
      appointments: [makeAppointment({ id: 'appt-owner', jobId: 'job-owner' })],
      technicians: [{ id: 'owner-bob', firstName: 'Bob', lastName: 'Smith', role: 'owner' }],
    });

    const res = await lookupCrewSchedule({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.freeTechnicians).toEqual([]);
    expect(res.data.bookings.map((b) => b.technicianName)).toEqual(['Bob Smith']);
    expect(res.summary).toContain('Bob Smith');
  });

  // Quality-review I3 — an UNCAPPED list must read with "and", not bare
  // commas ("Carlos, Mike and Dana", never "Carlos, Mike, Dana.").
  it('I3 — an uncapped free-technician list reads with a natural "and", not bare commas', async () => {
    const deps = await fixtures({
      technicians: [
        { id: 'tech-a', firstName: 'Carlos', lastName: 'Ruiz' },
        { id: 'tech-b', firstName: 'Mike', lastName: 'Diaz' },
        { id: 'tech-c', firstName: 'Dana', lastName: 'Lee' },
      ],
    });

    const res = await lookupCrewSchedule({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.summary).toContain('Carlos Ruiz, Mike Diaz and Dana Lee');
    expect(res.summary).not.toMatch(/Dana Lee,\s*\./); // never a dangling trailing comma
  });

  // Minor — resultCount reflects rows this lookup actually surfaced
  // (bookings), not the tenant's total roster size.
  it('minor — resultCount is the booking count, not the roster size', async () => {
    const job = makeJob({ id: 'job-1', assignedTechnicianId: 'tech-mike' });
    const deps = await fixtures({
      jobs: [job],
      appointments: [makeAppointment({ id: 'appt-1', jobId: 'job-1' })],
      technicians: [
        { id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' },
        { id: 'tech-carlos', firstName: 'Carlos', lastName: 'Ruiz' },
        { id: 'tech-dana', firstName: 'Dana', lastName: 'Lee' },
      ],
    });
    const lookupEvents = eventsSpy();

    await lookupCrewSchedule({ tenantId: TENANT, timezone: TZ, now: NOW }, { ...deps, lookupEvents });

    // I6 — record('found', ...) coverage for the whole-crew branch (only
    // the 'none'/error branches were previously exercised).
    expect(lookupEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ resultStatus: 'found', resultCount: 1 }), // 1 booking, not the 3-person roster
    );
  });

  it('reports status "none" and records the event when the tenant has no crew at all', async () => {
    const deps = await fixtures();
    const lookupEvents = eventsSpy();

    const res = await lookupCrewSchedule({ tenantId: TENANT, timezone: TZ, now: NOW }, { ...deps, lookupEvents });

    expect(res.status).toBe('none');
    expect(lookupEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, intent: 'lookup_crew_schedule', resultStatus: 'none' }),
    );
  });

  it('excludes canceled/no_show appointments from the busy set', async () => {
    const job = makeJob({ id: 'job-1', assignedTechnicianId: 'tech-mike' });
    const deps = await fixtures({
      jobs: [job],
      appointments: [makeAppointment({ id: 'appt-cxl', jobId: 'job-1', status: 'canceled' })],
      technicians: [{ id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' }],
    });

    const res = await lookupCrewSchedule({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.freeTechnicians).toEqual(['Mike Diaz']);
    expect(res.data.bookings).toEqual([]);
  });

  it('is tenant-scoped', async () => {
    const deps = await fixtures();
    await deps.userRepo.create({
      id: 'tech-foreign',
      tenantId: 'tenant-other',
      email: 'x@example.com',
      role: 'technician',
      firstName: 'Foreign',
      lastName: 'Tech',
      canFieldServe: true,
    });

    const res = await lookupCrewSchedule({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);

    expect(res.status).toBe('none');
  });

  it('truncates the free-technician list with an EXACT "and N more" tail (pinned count, not just toContain)', async () => {
    const technicians = Array.from({ length: 10 }, (_, i) => ({
      id: `tech-${i}`,
      firstName: `Tech${i}`,
      lastName: 'Person',
    }));
    const deps = await fixtures({ technicians });

    const res = await lookupCrewSchedule({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.freeTechnicians).toHaveLength(10);
    // MAX_SPOKEN_FREE is 8 — exactly 2 must be left over, not "some more".
    expect(res.summary).toContain('and 2 more');
    expect(res.summary).not.toContain('and 1 more');
    expect(res.summary).not.toContain('and 3 more');
  });

  describe('error path', () => {
    it('reports status "error" with an honest error message, never throwing', async () => {
      const deps = await fixtures({ technicians: [{ id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' }] });
      deps.appointmentRepo.findByDateRange = async () => {
        throw new Error('connection reset');
      };

      const res = await lookupCrewSchedule({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);

      expect(res.status).toBe('error');
      if (res.status !== 'error') throw new Error('unreachable');
      expect(res.data.error).toBe('connection reset');
      expect(res.summary).toMatch(/trouble/i);
    });

    it('records the lookup event on the error branch', async () => {
      const deps = await fixtures({ technicians: [{ id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' }] });
      deps.appointmentRepo.findByDateRange = async () => {
        throw new Error('db down');
      };
      const lookupEvents = eventsSpy();

      await lookupCrewSchedule({ tenantId: TENANT, timezone: TZ, now: NOW }, { ...deps, lookupEvents });

      expect(lookupEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT, intent: 'lookup_crew_schedule', resultStatus: 'error', resultCount: 0 }),
      );
    });

    it('a lookupEvents.record failure never breaks the caller-facing result', async () => {
      const deps = await fixtures({ technicians: [{ id: 'tech-mike', firstName: 'Mike', lastName: 'Diaz' }] });
      const failingEvents = {
        record: vi.fn(async () => {
          throw new Error('audit write failed');
        }),
      } as unknown as LookupEventService;

      const res = await lookupCrewSchedule(
        { tenantId: TENANT, timezone: TZ, now: NOW },
        { ...deps, lookupEvents: failingEvents },
      );

      expect(res.status).toBe('found');
    });
  });
});
