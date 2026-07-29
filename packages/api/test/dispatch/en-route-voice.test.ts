/**
 * B5.5 — "on my way" by voice: resolution + router-facing orchestration.
 *
 * AC-2 (speaker scoping): asserts the ACTUAL query args passed to
 * `assignmentRepo.findByTechnician`, not just the outcome — a future
 * refactor that widens the scope to a different/any technician must fail
 * this test.
 * AC-3 (resolution outcomes): named job → that appointment; bare → next
 * upcoming today; two candidates → ambiguous; zero → not_found (never
 * silent).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Appointment, AppointmentRepository } from '../../src/appointments/appointment';
import type { AppointmentAssignment, AssignmentRepository } from '../../src/appointments/assignment';
import type { Job, JobRepository } from '../../src/jobs/job';
import type { Customer, CustomerRepository } from '../../src/customers/customer';
import type { User, UserRepository } from '../../src/users/user';
import type { VoiceRepository } from '../../src/voice/voice-service';
import type { EnRouteEnqueuer } from '../../src/dispatch/routes';
import {
  resolveEnRouteAppointment,
  handleEnRouteVoiceIntent,
  type EnRouteResolutionDeps,
} from '../../src/dispatch/en-route-voice';

const TENANT = 'tenant-1';
const TECH = 'tech-canonical-uuid';
const OTHER_TECH = 'other-tech-uuid';
const NOW = new Date('2026-07-29T14:00:00.000Z'); // a Wednesday
const TODAY_BOUNDARY = { start: new Date('2026-07-29T00:00:00.000Z'), end: new Date('2026-07-29T23:59:59.999Z') };

function appt(overrides: Partial<Appointment>): Appointment {
  return {
    id: 'appt-default',
    tenantId: TENANT,
    jobId: 'job-default',
    scheduledStart: new Date('2026-07-29T15:00:00.000Z'),
    scheduledEnd: new Date('2026-07-29T16:00:00.000Z'),
    timezone: 'UTC',
    status: 'scheduled',
    holdPendingApproval: false,
    createdBy: 'someone',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Appointment;
}

function assignment(overrides: Partial<AppointmentAssignment>): AppointmentAssignment {
  return {
    id: 'assign-default',
    tenantId: TENANT,
    appointmentId: 'appt-default',
    technicianId: TECH,
    isPrimary: true,
    assignedBy: 'owner',
    assignedAt: NOW,
    ...overrides,
  };
}

/**
 * A REAL job summary: what the work is, not who it's for. The customer's name
 * lives on the customer record (`customerId`), which is the only place a
 * spoken "the Garcia job" can honestly be resolved from.
 */
function job(overrides: Partial<Job>): Job {
  return {
    id: 'job-default',
    tenantId: TENANT,
    customerId: 'cust-garcia',
    locationId: 'loc-1',
    jobNumber: 'JOB-0001',
    summary: 'AC repair',
    status: 'scheduled',
    priority: 'normal',
    ...overrides,
  } as Job;
}

function customer(overrides: Partial<Customer>): Customer {
  return {
    id: 'cust-garcia',
    tenantId: TENANT,
    firstName: 'Jamie',
    lastName: 'Garcia',
    displayName: 'Jamie Garcia',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    ...overrides,
  } as Customer;
}

/** A customer repo over a fixed set, keyed by id — nothing else is reachable. */
function customerRepoFor(customers: Customer[]): Pick<CustomerRepository, 'findById'> {
  return { findById: async (_t: string, id: string) => customers.find((c) => c.id === id) ?? null };
}

describe('B5.5 — resolveEnRouteAppointment (speaker scoping + resolution outcomes)', () => {
  it('AC-2: queries ONLY the acting technician\'s own assignments — asserts the call args, not just the outcome', async () => {
    const findByTechnician = vi.fn(async () => []);
    const deps: EnRouteResolutionDeps = {
      assignmentRepo: { findByTechnician },
      appointmentRepo: { findById: vi.fn(async () => null) },
    };

    await resolveEnRouteAppointment(deps, { tenantId: TENANT, technicianId: TECH, now: NOW });

    expect(findByTechnician).toHaveBeenCalledTimes(1);
    expect(findByTechnician).toHaveBeenCalledWith(TENANT, TECH);
    // Never queries for a DIFFERENT technician — the exact regression a
    // future "widen the scope" refactor would introduce.
    expect(findByTechnician).not.toHaveBeenCalledWith(TENANT, OTHER_TECH);
  });

  it('AC-3: a job named by its CUSTOMER ("the Garcia job") resolves through jobs.customer_id, not the summary', async () => {
    const a1 = assignment({ id: 'a1', appointmentId: 'appt-garcia', technicianId: TECH });
    const appointmentGarcia = appt({ id: 'appt-garcia', jobId: 'job-garcia', scheduledStart: new Date('2026-07-29T16:00:00.000Z') });
    // A perfectly ordinary job: the summary says what the work IS. The word
    // "Garcia" appears NOWHERE on it — only on the customer it links to — so
    // this can pass only if the resolver traverses job → customer.
    const jobGarcia = job({ id: 'job-garcia', summary: 'AC repair', customerId: 'cust-garcia' });
    expect(jobGarcia.summary.toLowerCase()).not.toContain('garcia');

    const deps: EnRouteResolutionDeps = {
      assignmentRepo: { findByTechnician: async () => [a1] },
      appointmentRepo: { findById: async (_t, id) => (id === 'appt-garcia' ? appointmentGarcia : null) },
      jobRepo: { findById: async (_t, id) => (id === 'job-garcia' ? jobGarcia : null) },
      customerRepo: customerRepoFor([customer({ id: 'cust-garcia' })]),
    };

    const result = await resolveEnRouteAppointment(deps, {
      tenantId: TENANT,
      technicianId: TECH,
      jobReference: 'the Garcia job',
      now: NOW,
    });

    expect(result).toEqual({
      kind: 'resolved',
      appointmentId: 'appt-garcia',
      jobId: 'job-garcia',
      scheduledStart: appointmentGarcia.scheduledStart,
    });
  });

  it('AC-3: a reference naming the WORK still matches the job summary (the pre-existing path is preserved)', async () => {
    const a1 = assignment({ id: 'a1', appointmentId: 'appt-ac', technicianId: TECH });
    const apptAc = appt({ id: 'appt-ac', jobId: 'job-ac', scheduledStart: new Date('2026-07-29T16:00:00.000Z') });
    const jobAc = job({ id: 'job-ac', summary: 'AC repair' });

    const deps: EnRouteResolutionDeps = {
      assignmentRepo: { findByTechnician: async () => [a1] },
      appointmentRepo: { findById: async (_t, id) => (id === 'appt-ac' ? apptAc : null) },
      jobRepo: { findById: async (_t, id) => (id === 'job-ac' ? jobAc : null) },
      // No customerRepo — summary matching must not depend on it.
    };

    const result = await resolveEnRouteAppointment(deps, {
      tenantId: TENANT,
      technicianId: TECH,
      jobReference: 'the AC repair job',
      now: NOW,
    });

    expect(result).toEqual({
      kind: 'resolved',
      appointmentId: 'appt-ac',
      jobId: 'job-ac',
      scheduledStart: apptAc.scheduledStart,
    });
  });

  it('without a customerRepo a customer-named reference degrades to not_found — never a throw, never a guess', async () => {
    const a1 = assignment({ id: 'a1', appointmentId: 'appt-garcia', technicianId: TECH });
    const appointmentGarcia = appt({ id: 'appt-garcia', jobId: 'job-garcia' });
    const jobGarcia = job({ id: 'job-garcia', summary: 'AC repair' });

    const deps: EnRouteResolutionDeps = {
      assignmentRepo: { findByTechnician: async () => [a1] },
      appointmentRepo: { findById: async () => appointmentGarcia },
      jobRepo: { findById: async () => jobGarcia },
      // customerRepo intentionally omitted — the optional-dependency contract.
    };

    const result = await resolveEnRouteAppointment(deps, {
      tenantId: TENANT,
      technicianId: TECH,
      jobReference: 'the Garcia job',
      now: NOW,
    });

    expect(result).toEqual({ kind: 'not_found' });
  });

  it('a customerRepo that throws degrades to summary-only matching instead of failing the whole "on my way"', async () => {
    const a1 = assignment({ id: 'a1', appointmentId: 'appt-ac', technicianId: TECH });
    const apptAc = appt({ id: 'appt-ac', jobId: 'job-ac' });
    const jobAc = job({ id: 'job-ac', summary: 'AC repair' });

    const deps: EnRouteResolutionDeps = {
      assignmentRepo: { findByTechnician: async () => [a1] },
      appointmentRepo: { findById: async () => apptAc },
      jobRepo: { findById: async () => jobAc },
      customerRepo: {
        findById: async () => {
          throw new Error('customer lookup exploded');
        },
      },
    };

    // The customer read fails; the summary still answers this reference.
    await expect(
      resolveEnRouteAppointment(deps, {
        tenantId: TENANT,
        technicianId: TECH,
        jobReference: 'the AC repair job',
        now: NOW,
      }),
    ).resolves.toEqual({
      kind: 'resolved',
      appointmentId: 'appt-ac',
      jobId: 'job-ac',
      scheduledStart: apptAc.scheduledStart,
    });

    // ...and a reference only the customer could have answered is not_found,
    // not an exception escaping into the voice worker.
    await expect(
      resolveEnRouteAppointment(deps, {
        tenantId: TENANT,
        technicianId: TECH,
        jobReference: 'the Garcia job',
        now: NOW,
      }),
    ).resolves.toEqual({ kind: 'not_found' });
  });

  it('a customer-named reference never reaches a DIFFERENT customer\'s job on the same technician', async () => {
    const a1 = assignment({ id: 'a1', appointmentId: 'appt-garcia' });
    const a2 = assignment({ id: 'a2', appointmentId: 'appt-nguyen' });
    const apptGarcia = appt({ id: 'appt-garcia', jobId: 'job-garcia', scheduledStart: new Date('2026-07-29T16:00:00.000Z') });
    const apptNguyen = appt({ id: 'appt-nguyen', jobId: 'job-nguyen', scheduledStart: new Date('2026-07-29T18:00:00.000Z') });
    const jobGarcia = job({ id: 'job-garcia', summary: 'AC repair', customerId: 'cust-garcia' });
    const jobNguyen = job({ id: 'job-nguyen', summary: 'Furnace tune-up', customerId: 'cust-nguyen' });

    const deps: EnRouteResolutionDeps = {
      assignmentRepo: { findByTechnician: async () => [a1, a2] },
      appointmentRepo: {
        findById: async (_t, id) => (id === 'appt-garcia' ? apptGarcia : id === 'appt-nguyen' ? apptNguyen : null),
      },
      jobRepo: {
        findById: async (_t, id) => (id === 'job-garcia' ? jobGarcia : id === 'job-nguyen' ? jobNguyen : null),
      },
      customerRepo: customerRepoFor([
        customer({ id: 'cust-garcia' }),
        customer({ id: 'cust-nguyen', firstName: 'Linh', lastName: 'Nguyen', displayName: 'Linh Nguyen' }),
      ]),
    };

    const result = await resolveEnRouteAppointment(deps, {
      tenantId: TENANT,
      technicianId: TECH,
      jobReference: 'the Garcia job',
      now: NOW,
    });

    expect(result).toEqual({
      kind: 'resolved',
      appointmentId: 'appt-garcia',
      jobId: 'job-garcia',
      scheduledStart: apptGarcia.scheduledStart,
    });
  });

  it('AC-3: bare "on my way" resolves to the tech\'s next upcoming appointment today', async () => {
    const later = assignment({ id: 'a-later', appointmentId: 'appt-later' });
    const sooner = assignment({ id: 'a-sooner', appointmentId: 'appt-sooner' });
    const apptLater = appt({ id: 'appt-later', jobId: 'job-later', scheduledStart: new Date('2026-07-29T18:00:00.000Z') });
    const apptSooner = appt({ id: 'appt-sooner', jobId: 'job-sooner', scheduledStart: new Date('2026-07-29T15:00:00.000Z') });

    const deps: EnRouteResolutionDeps = {
      assignmentRepo: { findByTechnician: async () => [later, sooner] },
      appointmentRepo: {
        findById: async (_t, id) => {
          if (id === 'appt-later') return apptLater;
          if (id === 'appt-sooner') return apptSooner;
          return null;
        },
      },
    };

    const result = await resolveEnRouteAppointment(deps, {
      tenantId: TENANT,
      technicianId: TECH,
      now: NOW,
      dayBoundary: TODAY_BOUNDARY,
    });

    expect(result).toEqual({
      kind: 'resolved',
      appointmentId: 'appt-sooner',
      jobId: 'job-sooner',
      scheduledStart: apptSooner.scheduledStart,
    });
  });

  // Raised in PR review against the day-boundary widening: once every earlier
  // appointment today became eligible, "earliest wins" could pick a stale
  // morning visit and text the WRONG customer. The bare path picks the visit
  // nearest to now in either direction — which also keeps the late-arrival
  // case the widening existed for.
  describe('AC-3: bare "on my way" picks the visit nearest to now, in either direction', () => {
    function depsFor(appts: Appointment[]): EnRouteResolutionDeps {
      return {
        assignmentRepo: {
          findByTechnician: async () =>
            appts.map((a, i) => assignment({ id: `a-${i}`, appointmentId: a.id })),
        },
        appointmentRepo: {
          findById: async (_t, id) => appts.find((a) => a.id === id) ?? null,
        },
      };
    }

    async function resolveAt(nowIso: string, appts: Appointment[]) {
      return resolveEnRouteAppointment(depsFor(appts), {
        tenantId: TENANT,
        technicianId: TECH,
        now: new Date(nowIso),
        dayBoundary: TODAY_BOUNDARY,
      });
    }

    it('at 15:00 does NOT pick a stale 09:00 over the real 16:00 visit', async () => {
      const stale = appt({ id: 'appt-stale', jobId: 'job-stale', scheduledStart: new Date('2026-07-29T09:00:00.000Z') });
      const real = appt({ id: 'appt-real', jobId: 'job-real', scheduledStart: new Date('2026-07-29T16:00:00.000Z') });

      const result = await resolveAt('2026-07-29T15:00:00.000Z', [stale, real]);

      expect(result).toMatchObject({ kind: 'resolved', appointmentId: 'appt-real' });
    });

    it('at 09:15 still picks the 09:00 the tech is running late to, over a 14:00', async () => {
      const overdue = appt({ id: 'appt-overdue', jobId: 'job-overdue', scheduledStart: new Date('2026-07-29T09:00:00.000Z') });
      const afternoon = appt({ id: 'appt-pm', jobId: 'job-pm', scheduledStart: new Date('2026-07-29T14:00:00.000Z') });

      const result = await resolveAt('2026-07-29T09:15:00.000Z', [overdue, afternoon]);

      expect(result).toMatchObject({ kind: 'resolved', appointmentId: 'appt-overdue' });
    });

    it('with every visit still ahead, behaves exactly as before — the earliest wins', async () => {
      const soon = appt({ id: 'appt-soon', jobId: 'job-soon', scheduledStart: new Date('2026-07-29T15:00:00.000Z') });
      const later = appt({ id: 'appt-later', jobId: 'job-later', scheduledStart: new Date('2026-07-29T18:00:00.000Z') });

      const result = await resolveAt('2026-07-29T14:00:00.000Z', [soon, later]);

      expect(result).toMatchObject({ kind: 'resolved', appointmentId: 'appt-soon' });
    });

    it('equidistant either side of now is a coin-flip — asks instead of guessing', async () => {
      const before = appt({ id: 'appt-before', jobId: 'job-before', scheduledStart: new Date('2026-07-29T13:00:00.000Z') });
      const after = appt({ id: 'appt-after', jobId: 'job-after', scheduledStart: new Date('2026-07-29T15:00:00.000Z') });

      const result = await resolveAt('2026-07-29T14:00:00.000Z', [before, after]);

      expect(result.kind).toBe('ambiguous');
    });
  });

  it('AC-3: two matching candidates yields ambiguous, never a guess', async () => {
    const a1 = assignment({ id: 'a1', appointmentId: 'appt-1' });
    const a2 = assignment({ id: 'a2', appointmentId: 'appt-2' });
    const appt1 = appt({ id: 'appt-1', jobId: 'job-1', scheduledStart: new Date('2026-07-29T15:00:00.000Z') });
    const appt2 = appt({ id: 'appt-2', jobId: 'job-2', scheduledStart: new Date('2026-07-29T17:00:00.000Z') });
    // Two jobs for the SAME customer, neither summary naming them.
    const job1 = job({ id: 'job-1', summary: 'AC repair', customerId: 'cust-garcia' });
    const job2 = job({ id: 'job-2', summary: 'Water heater replacement', customerId: 'cust-garcia' });

    const deps: EnRouteResolutionDeps = {
      assignmentRepo: { findByTechnician: async () => [a1, a2] },
      appointmentRepo: {
        findById: async (_t, id) => (id === 'appt-1' ? appt1 : id === 'appt-2' ? appt2 : null),
      },
      jobRepo: { findById: async (_t, id) => (id === 'job-1' ? job1 : id === 'job-2' ? job2 : null) },
      customerRepo: customerRepoFor([customer({ id: 'cust-garcia' })]),
    };

    const result = await resolveEnRouteAppointment(deps, {
      tenantId: TENANT,
      technicianId: TECH,
      jobReference: 'the Garcia job',
      now: NOW,
    });

    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates.map((c) => c.appointmentId).sort()).toEqual(['appt-1', 'appt-2']);
    }
  });

  it('AC-3: zero matches yields an explicit not_found outcome (never silent)', async () => {
    const deps: EnRouteResolutionDeps = {
      assignmentRepo: { findByTechnician: async () => [] },
      appointmentRepo: { findById: vi.fn(async () => null) },
    };

    const result = await resolveEnRouteAppointment(deps, { tenantId: TENANT, technicianId: TECH, now: NOW });

    expect(result).toEqual({ kind: 'not_found' });
  });

  it('excludes canceled appointments', async () => {
    const canceled = assignment({ id: 'a-canceled', appointmentId: 'appt-canceled' });
    const apptCanceled = appt({ id: 'appt-canceled', status: 'canceled', scheduledStart: new Date('2026-07-29T16:00:00.000Z') });

    const deps: EnRouteResolutionDeps = {
      assignmentRepo: { findByTechnician: async () => [canceled] },
      appointmentRepo: {
        findById: async (_t, id) => (id === 'appt-canceled' ? apptCanceled : null),
      },
    };

    const result = await resolveEnRouteAppointment(deps, {
      tenantId: TENANT,
      technicianId: TECH,
      now: NOW,
      dayBoundary: TODAY_BOUNDARY,
    });

    expect(result).toEqual({ kind: 'not_found' });
  });

  it('a same-day appointment that already started (the tech is running late) is still selectable', async () => {
    const running = assignment({ id: 'a-running', appointmentId: 'appt-running' });
    const apptRunning = appt({
      id: 'appt-running',
      jobId: 'job-running',
      status: 'in_progress',
      scheduledStart: new Date('2026-07-29T10:00:00.000Z'), // 4 hours before NOW (14:00), same day
    });

    const deps: EnRouteResolutionDeps = {
      assignmentRepo: { findByTechnician: async () => [running] },
      appointmentRepo: { findById: async (_t, id) => (id === 'appt-running' ? apptRunning : null) },
    };

    const result = await resolveEnRouteAppointment(deps, {
      tenantId: TENANT,
      technicianId: TECH,
      now: NOW,
      dayBoundary: TODAY_BOUNDARY,
    });

    expect(result).toEqual({
      kind: 'resolved',
      appointmentId: 'appt-running',
      jobId: 'job-running',
      scheduledStart: apptRunning.scheduledStart,
    });
  });

  it('an appointment from a different day is still excluded even though its status is eligible', async () => {
    const stale = assignment({ id: 'a-stale', appointmentId: 'appt-stale' });
    const apptStale = appt({
      id: 'appt-stale',
      scheduledStart: new Date('2026-07-28T10:00:00.000Z'), // yesterday, well outside today's boundary
    });

    const deps: EnRouteResolutionDeps = {
      assignmentRepo: { findByTechnician: async () => [stale] },
      appointmentRepo: { findById: async (_t, id) => (id === 'appt-stale' ? apptStale : null) },
    };

    const result = await resolveEnRouteAppointment(deps, {
      tenantId: TENANT,
      technicianId: TECH,
      now: NOW,
      dayBoundary: TODAY_BOUNDARY,
    });

    expect(result).toEqual({ kind: 'not_found' });
  });

  it('without a day boundary, still excludes an appointment already in the past (fallback behavior)', async () => {
    const past = assignment({ id: 'a-past', appointmentId: 'appt-past' });
    const apptPast = appt({ id: 'appt-past', scheduledStart: new Date('2026-07-29T10:00:00.000Z') });

    const deps: EnRouteResolutionDeps = {
      assignmentRepo: { findByTechnician: async () => [past] },
      appointmentRepo: { findById: async (_t, id) => (id === 'appt-past' ? apptPast : null) },
    };

    const result = await resolveEnRouteAppointment(deps, { tenantId: TENANT, technicianId: TECH, now: NOW });

    expect(result).toEqual({ kind: 'not_found' });
  });

  it('a named job reference with no jobRepo wired fails closed to not_found (never guesses)', async () => {
    const a1 = assignment({ id: 'a1', appointmentId: 'appt-1' });
    const appt1 = appt({ id: 'appt-1', scheduledStart: new Date('2026-07-29T15:00:00.000Z') });

    const deps: EnRouteResolutionDeps = {
      assignmentRepo: { findByTechnician: async () => [a1] },
      appointmentRepo: { findById: async () => appt1 },
      // jobRepo intentionally omitted
    };

    const result = await resolveEnRouteAppointment(deps, {
      tenantId: TENANT,
      technicianId: TECH,
      jobReference: 'the Garcia job',
      now: NOW,
    });

    expect(result).toEqual({ kind: 'not_found' });
  });
});

describe('B5.5 — handleEnRouteVoiceIntent (router orchestration)', () => {
  const RECORDING_ID = 'rec-1';

  function baseDeps(overrides: Partial<Parameters<typeof handleEnRouteVoiceIntent>[0]> = {}) {
    const technician: User = {
      id: TECH,
      tenantId: TENANT,
      clerkUserId: 'clerk-tech-1',
      email: 'tech@example.com',
      role: 'technician',
      firstName: 'Carlos',
      lastName: 'Ruiz',
      canFieldServe: true,
    } as User;

    const a1 = assignment({ id: 'a1', appointmentId: 'appt-1', technicianId: TECH });
    const appt1 = appt({ id: 'appt-1', jobId: 'job-1', scheduledStart: new Date('2026-07-29T15:00:00.000Z') });

    const enqueueEnRouteNotice = vi.fn(async () => 'appt-1:en_route');
    const enRouteCoordinator: EnRouteEnqueuer = { enqueueEnRouteNotice };
    const auditCreate = vi.fn(async () => undefined);

    return {
      userRepo: { findByTenant: async () => [technician] } as Pick<UserRepository, 'findByTenant'>,
      voiceRepo: {
        findById: async () => ({ id: RECORDING_ID, tenantId: TENANT, createdBy: 'clerk-tech-1' } as any),
      } as Pick<VoiceRepository, 'findById'>,
      assignmentRepo: { findByTechnician: async () => [a1] },
      appointmentRepo: { findById: async () => appt1 },
      enRouteCoordinator,
      auditRepo: { create: auditCreate } as any,
      now: () => NOW,
      ...overrides,
    };
  }

  it('unavailable when there is no recordingId (no answer surface on this path)', async () => {
    const outcome = await handleEnRouteVoiceIntent(baseDeps(), { tenantId: TENANT });
    expect(outcome).toEqual({ kind: 'unavailable' });
  });

  it('resolves the memo creator (Clerk id) to the canonical technician and fires the audited act', async () => {
    const deps = baseDeps();
    const outcome = await handleEnRouteVoiceIntent(deps, { tenantId: TENANT, recordingId: RECORDING_ID });

    expect(outcome.kind).toBe('answered');
    if (outcome.kind === 'answered') {
      expect(outcome.answer.result).toBe('found');
      expect(outcome.answer.intent).toBe('en_route');
    }
    expect(deps.enRouteCoordinator.enqueueEnRouteNotice).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, appointmentId: 'appt-1' }),
    );
    // Audited with the TECH actor — never a generic 'system' actor.
    expect(deps.auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'appointment.en_route_triggered',
        actorId: TECH,
        actorRole: 'technician',
        entityId: 'appt-1',
      }),
    );
  });

  it('an explicit "no upcoming appointment" answer when resolution finds nothing (never silent)', async () => {
    const deps = baseDeps({ assignmentRepo: { findByTechnician: async () => [] } });
    const outcome = await handleEnRouteVoiceIntent(deps, { tenantId: TENANT, recordingId: RECORDING_ID });

    expect(outcome.kind).toBe('answered');
    if (outcome.kind === 'answered') {
      expect(outcome.answer.result).toBe('none');
      expect(outcome.answer.summary.length).toBeGreaterThan(0);
    }
    expect(deps.enRouteCoordinator.enqueueEnRouteNotice).not.toHaveBeenCalled();
  });

  it('returns ambiguous candidates instead of guessing when the job reference matches more than one appointment', async () => {
    const a1 = assignment({ id: 'a1', appointmentId: 'appt-1' });
    const a2 = assignment({ id: 'a2', appointmentId: 'appt-2' });
    const appt1 = appt({ id: 'appt-1', jobId: 'job-1', scheduledStart: new Date('2026-07-29T15:00:00.000Z') });
    const appt2 = appt({ id: 'appt-2', jobId: 'job-2', scheduledStart: new Date('2026-07-29T17:00:00.000Z') });
    const job1 = job({ id: 'job-1', summary: 'AC repair', customerId: 'cust-garcia' });
    const job2 = job({ id: 'job-2', summary: 'Water heater replacement', customerId: 'cust-garcia' });

    const deps = baseDeps({
      assignmentRepo: { findByTechnician: async () => [a1, a2] },
      appointmentRepo: {
        findById: async (_t: string, id: string) => (id === 'appt-1' ? appt1 : id === 'appt-2' ? appt2 : null),
      },
      jobRepo: { findById: async (_t: string, id: string) => (id === 'job-1' ? job1 : id === 'job-2' ? job2 : null) },
      customerRepo: customerRepoFor([customer({ id: 'cust-garcia' })]),
    });

    const outcome = await handleEnRouteVoiceIntent(deps, {
      tenantId: TENANT,
      recordingId: RECORDING_ID,
      jobReference: 'the Garcia job',
    });

    expect(outcome.kind).toBe('ambiguous');
    if (outcome.kind === 'ambiguous') {
      expect(outcome.candidates).toHaveLength(2);
      expect(outcome.candidates.every((c) => c.kind === 'appointment')).toBe(true);
    }
    expect(deps.enRouteCoordinator.enqueueEnRouteNotice).not.toHaveBeenCalled();
  });

  it('forwards customerRepo to the resolver, so "on my way to the Garcia job" fires the act for an ordinarily-named job', async () => {
    const a1 = assignment({ id: 'a1', appointmentId: 'appt-1', technicianId: TECH });
    const appt1 = appt({ id: 'appt-1', jobId: 'job-1', scheduledStart: new Date('2026-07-29T15:00:00.000Z') });
    const job1 = job({ id: 'job-1', summary: 'AC repair', customerId: 'cust-garcia' });

    const deps = baseDeps({
      assignmentRepo: { findByTechnician: async () => [a1] },
      appointmentRepo: { findById: async () => appt1 },
      jobRepo: { findById: async () => job1 },
      customerRepo: customerRepoFor([customer({ id: 'cust-garcia' })]),
    });

    const outcome = await handleEnRouteVoiceIntent(deps, {
      tenantId: TENANT,
      recordingId: RECORDING_ID,
      jobReference: 'the Garcia job',
    });

    expect(outcome.kind).toBe('answered');
    if (outcome.kind === 'answered') expect(outcome.answer.result).toBe('found');
    expect(deps.enRouteCoordinator.enqueueEnRouteNotice).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, appointmentId: 'appt-1' }),
    );
  });

  it('unavailable when the memo creator cannot be resolved to a canonical technician', async () => {
    const deps = baseDeps({ userRepo: { findByTenant: async () => [] } });
    const outcome = await handleEnRouteVoiceIntent(deps, { tenantId: TENANT, recordingId: RECORDING_ID });
    expect(outcome).toEqual({ kind: 'unavailable' });
    expect(deps.enRouteCoordinator.enqueueEnRouteNotice).not.toHaveBeenCalled();
  });
});
