/**
 * Task 10 (2026-08-07 tradesperson plan) — `lookupMyDay` skill tests.
 *
 * The SPEAKER asks about their OWN schedule today. This skill takes an
 * ALREADY-RESOLVED `technicianId` (the router resolves the speaker via
 * `resolveCanonicalUser` BEFORE calling this skill — see
 * dispatch/en-route-voice.ts and workers/voice-lookup-answer.ts's
 * `lookup_my_day` case) — mirroring lookup_job_profit's "job is resolved
 * upstream" contract. The self-scoping security property (never falling
 * back to the whole crew's day when the speaker can't be identified) is
 * exercised at the ROUTER level (test/workers/voice-action-router.test.ts),
 * since that's where the resolution — and its failure mode — actually
 * happens; this file only covers the skill's own resolved-technicianId
 * contract: strict scoping to that ONE technician's appointments.
 */
import { describe, it, expect, vi } from 'vitest';
import { lookupMyDay } from '../../../src/ai/skills/lookup-my-day';
import { InMemoryAppointmentRepository } from '../../../src/appointments/in-memory-appointment';
import type { Appointment } from '../../../src/appointments/appointment';
import { InMemoryJobRepository, Job } from '../../../src/jobs/job';
import type { LookupEventService } from '../../../src/lookup-events/lookup-event-service';

const TENANT = 'tenant-1';
const TZ = 'America/New_York';
// 2026-06-11 ~07:00 New York (11:00 UTC).
const NOW = new Date('2026-06-11T11:00:00.000Z');
const ME = 'tech-mike';
const COWORKER = 'tech-carlos';

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
}

async function fixtures(opts: FixtureOpts = {}) {
  const appointmentRepo = new InMemoryAppointmentRepository();
  const jobRepo = new InMemoryJobRepository();
  for (const a of opts.appointments ?? []) await appointmentRepo.create(a);
  for (const j of opts.jobs ?? []) await jobRepo.create(j);
  return { appointmentRepo, jobRepo };
}

describe('lookupMyDay skill', () => {
  it("speaks the resolved technician's own appointments today, in start order", async () => {
    const jobEarly = makeJob({ id: 'job-early', summary: 'AC tune-up', assignedTechnicianId: ME });
    const jobLate = makeJob({ id: 'job-late', summary: 'Drain cleaning', assignedTechnicianId: ME });
    const deps = await fixtures({
      jobs: [jobEarly, jobLate],
      appointments: [
        makeAppointment({
          id: 'appt-late',
          jobId: 'job-late',
          scheduledStart: new Date('2026-06-11T18:00:00.000Z'), // 2pm NY
          scheduledEnd: new Date('2026-06-11T19:00:00.000Z'),
        }),
        makeAppointment({
          id: 'appt-early',
          jobId: 'job-early',
          scheduledStart: new Date('2026-06-11T13:00:00.000Z'), // 9am NY
          scheduledEnd: new Date('2026-06-11T14:00:00.000Z'),
        }),
      ],
    });

    const res = await lookupMyDay({ tenantId: TENANT, technicianId: ME, timezone: TZ, now: NOW }, deps);

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.appointments.map((a) => a.appointmentId)).toEqual(['appt-early', 'appt-late']);
    expect(res.summary).toContain('2 appointments today');
    expect(res.summary).toContain('AC tune-up');
    expect(res.summary).toContain('Drain cleaning');
  });

  it("NEVER includes a coworker's appointments — strictly scoped to the resolved technician", async () => {
    const myJob = makeJob({ id: 'job-mine', summary: 'My job', assignedTechnicianId: ME });
    const theirJob = makeJob({ id: 'job-theirs', summary: 'Their job', assignedTechnicianId: COWORKER });
    const deps = await fixtures({
      jobs: [myJob, theirJob],
      appointments: [
        makeAppointment({ id: 'appt-mine', jobId: 'job-mine' }),
        makeAppointment({ id: 'appt-theirs', jobId: 'job-theirs' }),
      ],
    });

    const res = await lookupMyDay({ tenantId: TENANT, technicianId: ME, timezone: TZ, now: NOW }, deps);

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.appointments.map((a) => a.appointmentId)).toEqual(['appt-mine']);
    expect(res.summary).not.toContain('Their job');
  });

  it('excludes canceled/no_show/completed appointments', async () => {
    const job = makeJob({ id: 'job-1', assignedTechnicianId: ME });
    const deps = await fixtures({
      jobs: [job],
      appointments: [
        makeAppointment({ id: 'appt-live', jobId: 'job-1' }),
        makeAppointment({ id: 'appt-cxl', jobId: 'job-1', status: 'canceled' }),
        makeAppointment({ id: 'appt-noshow', jobId: 'job-1', status: 'no_show' }),
        // Quality-review I5 — a completed job is done regardless of the
        // clock; crew-schedule DELIBERATELY keeps completed jobs (a
        // dispatcher's "who was busy" needs it), but my-day's "what's
        // next" must not read a finished visit back.
        makeAppointment({ id: 'appt-done', jobId: 'job-1', status: 'completed' }),
      ],
    });

    const res = await lookupMyDay({ tenantId: TENANT, technicianId: ME, timezone: TZ, now: NOW }, deps);

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.appointments.map((a) => a.appointmentId)).toEqual(['appt-live']);
  });

  // Quality-review I5 — the taxonomy advertises "What's my next job?" and
  // "Where am I going after this one?"; a technician asking at 3pm must
  // not hear their 8am job read back first (or at all).
  it('I5 — only shows appointments that are still ahead, never one already finished', async () => {
    const jobMorning = makeJob({ id: 'job-morning', assignedTechnicianId: ME, summary: 'Morning job (already done)' });
    const jobAfternoon = makeJob({ id: 'job-afternoon', assignedTechnicianId: ME, summary: 'Afternoon job (still ahead)' });
    const deps = await fixtures({
      jobs: [jobMorning, jobAfternoon],
      appointments: [
        makeAppointment({
          id: 'appt-morning',
          jobId: 'job-morning',
          // 6am-8am NY — well before NOW (07:00 NY).
          scheduledStart: new Date('2026-06-11T10:00:00.000Z'),
          scheduledEnd: new Date('2026-06-11T12:00:00.000Z'),
        }),
        makeAppointment({
          id: 'appt-afternoon',
          jobId: 'job-afternoon',
          // 2pm-4pm NY — after NOW.
          scheduledStart: new Date('2026-06-11T18:00:00.000Z'),
          scheduledEnd: new Date('2026-06-11T20:00:00.000Z'),
        }),
      ],
    });

    // NOW is 11:00 UTC = 07:00 America/New_York — after the morning job's
    // scheduledEnd (12:00 UTC = 08:00 NY)... use a NOW between the two.
    const midday = new Date('2026-06-11T16:00:00.000Z'); // noon NY

    const res = await lookupMyDay({ tenantId: TENANT, technicianId: ME, timezone: TZ, now: midday }, deps);

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.appointments.map((a) => a.jobSummary)).toEqual(['Afternoon job (still ahead)']);
    expect(res.summary).not.toContain('Morning job');
  });

  it('I5 — a fully-finished day reports "none", not the completed appointments', async () => {
    const job = makeJob({ id: 'job-1', assignedTechnicianId: ME, summary: 'Long-done job' });
    const deps = await fixtures({
      jobs: [job],
      appointments: [
        makeAppointment({
          id: 'appt-past',
          jobId: 'job-1',
          scheduledStart: new Date('2026-06-11T10:00:00.000Z'),
          scheduledEnd: new Date('2026-06-11T12:00:00.000Z'),
        }),
      ],
    });
    const lateInDay = new Date('2026-06-11T22:00:00.000Z'); // 6pm NY, well after appt end

    const res = await lookupMyDay({ tenantId: TENANT, technicianId: ME, timezone: TZ, now: lateInDay }, deps);

    expect(res.status).toBe('none');
  });

  it('only shows TODAY — an appointment on another day never appears', async () => {
    const job = makeJob({ id: 'job-1', assignedTechnicianId: ME });
    const deps = await fixtures({
      jobs: [job],
      appointments: [
        makeAppointment({
          id: 'appt-tomorrow',
          jobId: 'job-1',
          scheduledStart: new Date('2026-06-12T13:00:00.000Z'),
          scheduledEnd: new Date('2026-06-12T14:00:00.000Z'),
        }),
      ],
    });

    const res = await lookupMyDay({ tenantId: TENANT, technicianId: ME, timezone: TZ, now: NOW }, deps);

    expect(res.status).toBe('none');
  });

  // Quality-review C2 — a job created long before MAX_JOB_LIMIT more-recent
  // jobs, with a real appointment TODAY, must still show on "my day" —
  // never dropped because it fell off a findByTenant({ technicianId,
  // limit }) page ordered by createdAt DESC. A technician with over a
  // year of job history (250+ jobs) is a NORMAL tenure, not an edge case.
  it('C2 — an old job outside a recency-limited page with an appointment today still appears', async () => {
    const oldJob = makeJob({
      id: 'job-old',
      assignedTechnicianId: ME,
      summary: 'Old maintenance visit',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    });
    const deps = await fixtures({
      jobs: [oldJob],
      appointments: [makeAppointment({ id: 'appt-old', jobId: 'job-old' })],
    });
    const newerBase = new Date('2026-06-01T00:00:00.000Z').getTime();
    for (let i = 0; i < 250; i++) {
      await deps.jobRepo.create({
        id: `job-new-${i}`,
        tenantId: TENANT,
        customerId: 'cust-1',
        locationId: 'loc-1',
        jobNumber: `JOB-${1000 + i}`,
        summary: `newer ${i}`,
        status: 'scheduled',
        priority: 'normal',
        assignedTechnicianId: ME,
        createdBy: 'u1',
        createdAt: new Date(newerBase + i * 1000),
        updatedAt: new Date(newerBase + i * 1000),
      } as Job);
    }

    const res = await lookupMyDay({ tenantId: TENANT, technicianId: ME, timezone: TZ, now: NOW }, deps);

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.appointments.map((a) => a.jobSummary)).toEqual(['Old maintenance visit']);
  });

  it('returns status "none" with a clear-day summary and records the event when nothing is on', async () => {
    const deps = await fixtures();
    const lookupEvents = eventsSpy();

    const res = await lookupMyDay(
      { tenantId: TENANT, technicianId: ME, timezone: TZ, now: NOW },
      { ...deps, lookupEvents },
    );

    expect(res.status).toBe('none');
    expect(res.summary).toMatch(/clear|nothing/i);
    expect(lookupEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, intent: 'lookup_my_day', resultStatus: 'none', resultCount: 0 }),
    );
  });

  it('is tenant-scoped', async () => {
    const foreignJob = makeJob({ id: 'job-foreign', tenantId: 'tenant-other', assignedTechnicianId: ME });
    const deps = await fixtures({
      jobs: [foreignJob],
      appointments: [makeAppointment({ id: 'appt-foreign', tenantId: 'tenant-other', jobId: 'job-foreign' })],
    });

    const res = await lookupMyDay({ tenantId: TENANT, technicianId: ME, timezone: TZ, now: NOW }, deps);

    expect(res.status).toBe('none');
  });

  it('records the lookup event on the found branch with sessionId threaded through', async () => {
    const job = makeJob({ id: 'job-1', assignedTechnicianId: ME });
    const deps = await fixtures({ jobs: [job], appointments: [makeAppointment({ jobId: 'job-1' })] });
    const lookupEvents = eventsSpy();

    const res = await lookupMyDay(
      { tenantId: TENANT, technicianId: ME, timezone: TZ, now: NOW, sessionId: 'sess-1' },
      { ...deps, lookupEvents },
    );

    expect(res.status).toBe('found');
    expect(lookupEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        intent: 'lookup_my_day',
        sessionId: 'sess-1',
        resultStatus: 'found',
        resultCount: 1,
      }),
    );
  });

  describe('error path', () => {
    it('reports status "error" with an honest error message, never throwing', async () => {
      const deps = await fixtures();
      deps.appointmentRepo.findByDateRange = async () => {
        throw new Error('connection reset');
      };

      const res = await lookupMyDay({ tenantId: TENANT, technicianId: ME, timezone: TZ, now: NOW }, deps);

      expect(res.status).toBe('error');
      if (res.status !== 'error') throw new Error('unreachable');
      expect(res.data.error).toBe('connection reset');
      expect(res.summary).toMatch(/trouble/i);
    });

    it('records the lookup event on the error branch', async () => {
      const deps = await fixtures();
      deps.appointmentRepo.findByDateRange = async () => {
        throw new Error('db down');
      };
      const lookupEvents = eventsSpy();

      await lookupMyDay({ tenantId: TENANT, technicianId: ME, timezone: TZ, now: NOW }, { ...deps, lookupEvents });

      expect(lookupEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT, intent: 'lookup_my_day', resultStatus: 'error', resultCount: 0 }),
      );
    });

    it('a lookupEvents.record failure never breaks the caller-facing result', async () => {
      const deps = await fixtures();
      const failingEvents = {
        record: vi.fn(async () => {
          throw new Error('audit write failed');
        }),
      } as unknown as LookupEventService;

      const res = await lookupMyDay(
        { tenantId: TENANT, technicianId: ME, timezone: TZ, now: NOW },
        { ...deps, lookupEvents: failingEvents },
      );

      expect(res.status).toBe('none');
    });
  });
});
