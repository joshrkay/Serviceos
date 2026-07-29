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

function job(overrides: Partial<Job>): Job {
  return {
    id: 'job-default',
    tenantId: TENANT,
    customerId: 'cust-1',
    locationId: 'loc-1',
    jobNumber: 'JOB-0001',
    summary: 'Garcia — AC repair',
    status: 'scheduled',
    priority: 'normal',
  } as Job;
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

  it('AC-3: named job with a unique match resolves to that appointment', async () => {
    const a1 = assignment({ id: 'a1', appointmentId: 'appt-garcia', technicianId: TECH });
    const appointmentGarcia = appt({ id: 'appt-garcia', jobId: 'job-garcia', scheduledStart: new Date('2026-07-29T16:00:00.000Z') });
    const jobGarcia = job({ id: 'job-garcia', summary: 'Garcia — AC repair' });

    const deps: EnRouteResolutionDeps = {
      assignmentRepo: { findByTechnician: async () => [a1] },
      appointmentRepo: { findById: async (_t, id) => (id === 'appt-garcia' ? appointmentGarcia : null) },
      jobRepo: { findById: async (_t, id) => (id === 'job-garcia' ? jobGarcia : null) },
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

  it('AC-3: two matching candidates yields ambiguous, never a guess', async () => {
    const a1 = assignment({ id: 'a1', appointmentId: 'appt-1' });
    const a2 = assignment({ id: 'a2', appointmentId: 'appt-2' });
    const appt1 = appt({ id: 'appt-1', jobId: 'job-1', scheduledStart: new Date('2026-07-29T15:00:00.000Z') });
    const appt2 = appt({ id: 'appt-2', jobId: 'job-2', scheduledStart: new Date('2026-07-29T17:00:00.000Z') });
    const job1 = job({ id: 'job-1', summary: 'Garcia — AC repair' });
    const job2 = job({ id: 'job-2', summary: 'Garcia — water heater' });

    const deps: EnRouteResolutionDeps = {
      assignmentRepo: { findByTechnician: async () => [a1, a2] },
      appointmentRepo: {
        findById: async (_t, id) => (id === 'appt-1' ? appt1 : id === 'appt-2' ? appt2 : null),
      },
      jobRepo: { findById: async (_t, id) => (id === 'job-1' ? job1 : id === 'job-2' ? job2 : null) },
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
    const job1 = job({ id: 'job-1', summary: 'Garcia — AC repair' });
    const job2 = job({ id: 'job-2', summary: 'Garcia — water heater' });

    const deps = baseDeps({
      assignmentRepo: { findByTechnician: async () => [a1, a2] },
      appointmentRepo: {
        findById: async (_t: string, id: string) => (id === 'appt-1' ? appt1 : id === 'appt-2' ? appt2 : null),
      },
      jobRepo: { findById: async (_t: string, id: string) => (id === 'job-1' ? job1 : id === 'job-2' ? job2 : null) },
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

  it('unavailable when the memo creator cannot be resolved to a canonical technician', async () => {
    const deps = baseDeps({ userRepo: { findByTenant: async () => [] } });
    const outcome = await handleEnRouteVoiceIntent(deps, { tenantId: TENANT, recordingId: RECORDING_ID });
    expect(outcome).toEqual({ kind: 'unavailable' });
    expect(deps.enRouteCoordinator.enqueueEnRouteNotice).not.toHaveBeenCalled();
  });
});
