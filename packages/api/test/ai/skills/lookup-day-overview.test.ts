/**
 * RV-010 — `lookup_day_overview` skill tests. Fixture repos only (no
 * gateway — the skill is deterministic composition over tenant data).
 */
import { describe, it, expect } from 'vitest';
import { lookupDayOverview } from '../../../src/ai/skills/lookup-day-overview';
import { InMemoryAppointmentRepository } from '../../../src/appointments/in-memory-appointment';
import type { Appointment } from '../../../src/appointments/appointment';
import { InMemoryJobRepository, Job } from '../../../src/jobs/job';
import { InMemoryUserRepository } from '../../../src/users/user';
import { InMemoryProposalRepository, Proposal, createProposal } from '../../../src/proposals/proposal';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const TZ = 'America/New_York';
// 2026-06-11 ~07:00 New York (11:00 UTC).
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

function makeProposalRow(over: Partial<Proposal>): Proposal {
  const base = createProposal({
    tenantId: TENANT,
    proposalType: 'draft_invoice',
    payload: {},
    summary: 'A proposal',
    createdBy: 'u1',
  });
  return { ...base, ...over };
}

interface FixtureOpts {
  appointments?: Appointment[];
  jobs?: Job[];
  proposals?: Proposal[];
  withUsers?: boolean;
}

async function fixtures(opts: FixtureOpts = {}) {
  const appointmentRepo = new InMemoryAppointmentRepository();
  const jobRepo = new InMemoryJobRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const userRepo = new InMemoryUserRepository();
  for (const a of opts.appointments ?? []) await appointmentRepo.create(a);
  for (const j of opts.jobs ?? []) await jobRepo.create(j);
  for (const p of opts.proposals ?? []) await proposalRepo.create(p);
  if (opts.withUsers) {
    await userRepo.create({
      id: 'tech-mike',
      tenantId: TENANT,
      email: 'mike@example.com',
      role: 'technician',
      firstName: 'Mike',
      lastName: 'Diaz',
      canFieldServe: true,
    });
  }
  return { appointmentRepo, jobRepo, proposalRepo, userRepo };
}

describe('lookupDayOverview (RV-010)', () => {
  it('speaks today\'s appointments in start order with technician names', async () => {
    const jobEarly = makeJob({ id: 'job-early', summary: 'AC tune-up', assignedTechnicianId: 'tech-mike' });
    const jobLate = makeJob({ id: 'job-late', summary: 'Drain cleaning' });
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
      withUsers: true,
    });

    const result = await lookupDayOverview({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);

    expect(result.status).toBe('found');
    if (result.status === 'error') throw new Error('unexpected');
    expect(result.data.appointments.map((a) => a.appointmentId)).toEqual([
      'appt-early',
      'appt-late',
    ]);
    expect(result.data.appointments[0].technicianName).toBe('Mike Diaz');
    expect(result.summary).toContain('2 appointments today');
    expect(result.summary).toContain('9 AM — AC tune-up with Mike Diaz');
    expect(result.summary).toContain('2 PM — Drain cleaning');
  });

  it('puts urgent/high-priority jobs FIRST in the spoken summary, urgent ahead of high', async () => {
    const deps = await fixtures({
      jobs: [
        makeJob({ id: 'job-high', summary: 'Leaky faucet at Smith', priority: 'high' }),
        makeJob({ id: 'job-urgent', summary: 'Burst pipe at Miller', priority: 'urgent' }),
        makeJob({ id: 'job-normal', summary: 'Routine filter swap', priority: 'normal' }),
        makeJob({ id: 'job-done', summary: 'Old urgent thing', priority: 'urgent', status: 'completed' }),
      ],
      appointments: [makeAppointment({ jobId: 'job-normal' })],
    });

    const result = await lookupDayOverview({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);

    expect(result.status).toBe('found');
    if (result.status === 'error') throw new Error('unexpected');
    expect(result.data.urgentJobs.map((j) => j.jobId)).toEqual(['job-urgent', 'job-high']);
    expect(result.summary.indexOf('Burst pipe at Miller')).toBeGreaterThan(-1);
    // Urgent line is spoken before the schedule line.
    expect(result.summary.indexOf('Heads up')).toBeLessThan(result.summary.indexOf('appointment'));
    expect(result.summary.indexOf('Burst pipe at Miller')).toBeLessThan(
      result.summary.indexOf('Leaky faucet at Smith'),
    );
  });

  it('counts pending approvals (draft + ready_for_review) via the inbox composition', async () => {
    const deps = await fixtures({
      proposals: [
        makeProposalRow({ id: 'p-draft', status: 'draft', createdAt: new Date('2026-06-01T00:00:00.000Z') }),
        makeProposalRow({ id: 'p-ready', status: 'ready_for_review', createdAt: new Date('2026-06-01T00:00:00.000Z') }),
        makeProposalRow({ id: 'p-done', status: 'executed', createdAt: new Date('2026-06-01T00:00:00.000Z'), updatedAt: new Date('2026-06-01T00:00:00.000Z') }),
      ],
    });

    const result = await lookupDayOverview({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);

    expect(result.status).toBe('found');
    if (result.status === 'error') throw new Error('unexpected');
    expect(result.data.pendingApprovalsCount).toBe(2);
    expect(result.summary).toContain('2 approvals are waiting on you');
  });

  it('summarizes overnight events since yesterday 6pm tenant-local via listSince', async () => {
    // Yesterday 6pm NY = 2026-06-10T22:00Z. 11pm NY = 2026-06-11T03:00Z is inside.
    const overnight = new Date('2026-06-11T03:00:00.000Z');
    const beforeWindow = new Date('2026-06-10T12:00:00.000Z');
    const deps = await fixtures({
      proposals: [
        makeProposalRow({ id: 'p-new', status: 'executed', createdAt: overnight, executedAt: overnight }),
        makeProposalRow({ id: 'p-failed', status: 'execution_failed', createdAt: beforeWindow, updatedAt: overnight }),
        makeProposalRow({ id: 'p-old', status: 'executed', createdAt: beforeWindow, executedAt: beforeWindow, updatedAt: beforeWindow }),
      ],
    });

    const result = await lookupDayOverview({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);

    expect(result.status).toBe('found');
    if (result.status === 'error') throw new Error('unexpected');
    expect(result.data.overnight).toEqual({ createdCount: 1, executedCount: 1, failedCount: 1 });
    expect(result.summary).toContain('Overnight: 1 new proposal came in, 1 executed, 1 failed.');
  });

  it('excludes canceled appointments and other tenants\' data', async () => {
    const deps = await fixtures({
      jobs: [makeJob({ id: 'job-1' }), makeJob({ id: 'job-foreign', tenantId: OTHER_TENANT, priority: 'urgent' })],
      appointments: [
        makeAppointment({ id: 'appt-live', jobId: 'job-1' }),
        makeAppointment({ id: 'appt-cxl', jobId: 'job-1', status: 'canceled' }),
        makeAppointment({ id: 'appt-foreign', tenantId: OTHER_TENANT, jobId: 'job-foreign' }),
      ],
      proposals: [makeProposalRow({ id: 'p-foreign', tenantId: OTHER_TENANT, status: 'draft' })],
    });

    const result = await lookupDayOverview({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);

    expect(result.status).toBe('found');
    if (result.status === 'error') throw new Error('unexpected');
    expect(result.data.appointments.map((a) => a.appointmentId)).toEqual(['appt-live']);
    expect(result.data.urgentJobs).toEqual([]);
    expect(result.data.pendingApprovalsCount).toBe(0);
  });

  it('returns status none with a clear-day summary when nothing is on', async () => {
    const deps = await fixtures();
    const result = await lookupDayOverview({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);
    expect(result.status).toBe('none');
    expect(result.summary).toBe(
      'Your day is clear — no appointments today and nothing is waiting on you.',
    );
  });

  it('degrades to an error summary when a repo throws', async () => {
    const deps = await fixtures();
    deps.appointmentRepo.findByDateRange = async () => {
      throw new Error('boom');
    };
    const result = await lookupDayOverview({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);
    expect(result.status).toBe('error');
    expect(result.summary).toBe("I'm having trouble pulling up your day right now.");
  });

  it('works without a userRepo (no technician names, no crash)', async () => {
    const job = makeJob({ id: 'job-1', assignedTechnicianId: 'tech-mike' });
    const { appointmentRepo, jobRepo, proposalRepo } = await fixtures({
      jobs: [job],
      appointments: [makeAppointment({ jobId: 'job-1' })],
    });
    const result = await lookupDayOverview(
      { tenantId: TENANT, timezone: TZ, now: NOW },
      { appointmentRepo, jobRepo, proposalRepo },
    );
    expect(result.status).toBe('found');
    if (result.status === 'error') throw new Error('unexpected');
    expect(result.data.appointments[0].technicianName).toBeUndefined();
  });

  it('THROWING-userRepo: findByTenant throws → skill still returns found, tech names absent', async () => {
    // Fix #3: the userRepo error catch block in the skill must swallow the
    // throw and continue; technician names are decorative and must never
    // fail the overview.
    const job = makeJob({ id: 'job-1', assignedTechnicianId: 'tech-mike', summary: 'Boiler check' });
    const deps = await fixtures({
      jobs: [job],
      appointments: [makeAppointment({ jobId: 'job-1' })],
      withUsers: true,
    });
    // Override findByTenant to throw unconditionally.
    deps.userRepo.findByTenant = async () => {
      throw new Error('user store unavailable');
    };

    const result = await lookupDayOverview({ tenantId: TENANT, timezone: TZ, now: NOW }, deps);

    expect(result.status).toBe('found');
    if (result.status === 'error') throw new Error('unexpected error result');
    // Appointments still present — the repo error only suppressed names.
    expect(result.data.appointments).toHaveLength(1);
    expect(result.data.appointments[0].technicianName).toBeUndefined();
    // Summary must not contain the tech's name (would only appear if names loaded).
    expect(result.summary).not.toContain('Mike Diaz');
  });

  it('records a lookup_events audit row when wired', async () => {
    const deps = await fixtures({ appointments: [makeAppointment({})], jobs: [makeJob({ id: 'job-1' })] });
    const recorded: unknown[] = [];
    const result = await lookupDayOverview(
      { tenantId: TENANT, timezone: TZ, now: NOW, sessionId: 'sess-1' },
      {
        ...deps,
        lookupEvents: {
          record: async (input: unknown) => {
            recorded.push(input);
          },
        } as never,
      },
    );
    expect(result.status).toBe('found');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      tenantId: TENANT,
      intent: 'lookup_day_overview',
      sessionId: 'sess-1',
      resultStatus: 'found',
    });
  });
});
