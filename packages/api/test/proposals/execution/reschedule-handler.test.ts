import { describe, it, expect, beforeEach } from 'vitest';
import { RescheduleAppointmentExecutionHandler } from '../../../src/proposals/execution/reschedule-handler';
import { Proposal } from '../../../src/proposals/proposal';
import { InMemoryAppointmentRepository, createAppointment } from '../../../src/appointments/appointment';
import { FeasibilityDependencies } from '../../../src/scheduling/feasibility-types';
import { StubSkillMatcher } from '../../../src/scheduling/skill-matcher';
import { HaversineFallbackProvider } from '../../../src/scheduling/travel-time/haversine-fallback';
import { InMemoryAssignmentRepository } from '../../../src/appointments/assignment';

describe('P6-013 — Execution for reschedule proposals', () => {
  let handler: RescheduleAppointmentExecutionHandler;
  let appointmentRepo: InMemoryAppointmentRepository;

  const tenantId = '550e8400-e29b-41d4-a716-446655440000';
  const context = { tenantId, executedBy: 'user-1' };

  function makeProposal(payload: Record<string, unknown>): Proposal {
    return {
      id: 'prop-1',
      tenantId,
      proposalType: 'reschedule_appointment',
      status: 'approved',
      payload,
      summary: 'Reschedule appointment',
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  beforeEach(() => {
    appointmentRepo = new InMemoryAppointmentRepository();
    handler = new RescheduleAppointmentExecutionHandler(appointmentRepo);
  });

  it('reschedules appointment with new times', async () => {
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-03-14T09:00:00Z'),
      scheduledEnd: new Date('2026-03-14T11:00:00Z'),
      timezone: 'America/New_York', createdBy: 'user-1',
    }, appointmentRepo);

    const proposal = makeProposal({
      appointmentId: appt.id,
      newScheduledStart: '2026-03-15T10:00:00Z',
      newScheduledEnd: '2026-03-15T12:00:00Z',
    });

    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe(appt.id);

    const updated = await appointmentRepo.findById(tenantId, appt.id);
    expect(updated!.scheduledStart.toISOString()).toBe('2026-03-15T10:00:00.000Z');
    expect(updated!.scheduledEnd.toISOString()).toBe('2026-03-15T12:00:00.000Z');
  });

  it('rejects invalid time ordering', async () => {
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-03-14T09:00:00Z'),
      scheduledEnd: new Date('2026-03-14T11:00:00Z'),
      timezone: 'America/New_York', createdBy: 'user-1',
    }, appointmentRepo);

    const proposal = makeProposal({
      appointmentId: appt.id,
      newScheduledStart: '2026-03-15T12:00:00Z',
      newScheduledEnd: '2026-03-15T10:00:00Z',
    });

    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('scheduledStart must be before scheduledEnd');
  });

  it('rejects missing appointmentId', async () => {
    const proposal = makeProposal({
      newScheduledStart: '2026-03-15T10:00:00Z',
      newScheduledEnd: '2026-03-15T12:00:00Z',
    });
    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(false);
  });

  it('rejects missing newScheduledStart', async () => {
    const proposal = makeProposal({
      appointmentId: 'appt-1',
      newScheduledEnd: '2026-03-15T12:00:00Z',
    });
    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(false);
  });

  it('rejects non-existent appointment', async () => {
    const proposal = makeProposal({
      appointmentId: 'nonexistent',
      newScheduledStart: '2026-03-15T10:00:00Z',
      newScheduledEnd: '2026-03-15T12:00:00Z',
    });
    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(false);
  });

  it('enforces tenant isolation', async () => {
    const appt = await createAppointment({
      tenantId: 'other-tenant', jobId: 'job-1',
      scheduledStart: new Date('2026-03-14T09:00:00Z'),
      scheduledEnd: new Date('2026-03-14T11:00:00Z'),
      timezone: 'America/New_York', createdBy: 'user-1',
    }, appointmentRepo);

    const proposal = makeProposal({
      appointmentId: appt.id,
      newScheduledStart: '2026-03-15T10:00:00Z',
      newScheduledEnd: '2026-03-15T12:00:00Z',
    });
    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(false);
  });

  it('is idempotent — reschedule to same times succeeds', async () => {
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-03-15T10:00:00Z'),
      scheduledEnd: new Date('2026-03-15T12:00:00Z'),
      timezone: 'America/New_York', createdBy: 'user-1',
    }, appointmentRepo);

    const proposal = makeProposal({
      appointmentId: appt.id,
      newScheduledStart: '2026-03-15T10:00:00Z',
      newScheduledEnd: '2026-03-15T12:00:00Z',
    });

    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(true);
  });

  it('rejects an unedited tech-out proposal (requiresSlotSelection + same times) so APPROVE ALL cannot fire a no-op customer SMS', async () => {
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-03-15T10:00:00Z'),
      scheduledEnd: new Date('2026-03-15T12:00:00Z'),
      timezone: 'America/New_York', createdBy: 'user-1',
    }, appointmentRepo);

    // Seeded with the appointment's CURRENT times (P6-028 tech-out shape).
    const proposal: Proposal = {
      ...makeProposal({
        appointmentId: appt.id,
        newScheduledStart: '2026-03-15T10:00:00Z',
        newScheduledEnd: '2026-03-15T12:00:00Z',
      }),
      sourceContext: { requiresSlotSelection: true },
    };

    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('no new time selected');

    // Once the owner picks a real slot, the same flagged proposal executes.
    const edited: Proposal = {
      ...proposal,
      payload: {
        appointmentId: appt.id,
        newScheduledStart: '2026-03-16T10:00:00Z',
        newScheduledEnd: '2026-03-16T12:00:00Z',
      },
    };
    const ok = await handler.execute(edited, context);
    expect(ok.success).toBe(true);
  });

  it('rejects when feasibility reports a blocking overlap', async () => {
    const assignmentRepo = new InMemoryAssignmentRepository();
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-05-17T10:00:00Z'),
      scheduledEnd: new Date('2026-05-17T11:00:00Z'),
      timezone: 'UTC', createdBy: 'user-1',
    }, appointmentRepo);
    await assignmentRepo.create({
      id: 'as-1', tenantId, appointmentId: appt.id,
      technicianId: 'tech-1', isPrimary: true, assignedBy: 'user-1', assignedAt: new Date(),
    });
    const conflict = await createAppointment({
      tenantId, jobId: 'job-2',
      scheduledStart: new Date('2026-05-17T12:30:00Z'),
      scheduledEnd: new Date('2026-05-17T13:30:00Z'),
      timezone: 'UTC', createdBy: 'user-1',
    }, appointmentRepo);
    await assignmentRepo.create({
      id: 'as-2', tenantId, appointmentId: conflict.id,
      technicianId: 'tech-1', isPrimary: true, assignedBy: 'user-1', assignedAt: new Date(),
    });

    const feasibilityDeps: FeasibilityDependencies = {
      assignmentRepo, appointmentRepo,
      jobRepo: { findById: async () => null } as any,
      locationRepo: { findById: async () => null } as any,
      workingHoursRepo: { findByTechnicianAndDay: async () => null } as any,
      unavailableBlockRepo: { findByTechnicianAndDateRange: async () => [] } as any,
      travelTimeProvider: new HaversineFallbackProvider(),
      skillMatcher: new StubSkillMatcher(),
    };
    handler = new RescheduleAppointmentExecutionHandler(
      appointmentRepo, assignmentRepo, undefined, undefined, feasibilityDeps,
    );

    const proposal = makeProposal({
      appointmentId: appt.id,
      newScheduledStart: '2026-05-17T12:00:00Z',
      newScheduledEnd: '2026-05-17T13:00:00Z',
    });
    // No sourceContext on proposal so freshness passes automatically.
    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Overlaps with/);
  });

  it('passes feasibility (warnings only) and surfaces them on the result', async () => {
    const assignmentRepo = new InMemoryAssignmentRepository();
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-05-17T10:00:00Z'),
      scheduledEnd: new Date('2026-05-17T11:00:00Z'),
      timezone: 'UTC', createdBy: 'user-1',
    }, appointmentRepo);
    await assignmentRepo.create({
      id: 'as-1', tenantId, appointmentId: appt.id,
      technicianId: 'tech-1', isPrimary: true, assignedBy: 'user-1', assignedAt: new Date(),
    });

    // Inject a working-hours mock that triggers an "outside working hours" warning.
    const workingHoursRepo: any = {
      findByTechnicianAndDay: async () => ({
        id: 'wh', tenantId, technicianId: 'tech-1',
        dayOfWeek: 0, startTime: '14:00', endTime: '17:00', isActive: true,
        createdAt: new Date(), updatedAt: new Date(),
      }),
    };
    const feasibilityDeps: FeasibilityDependencies = {
      assignmentRepo, appointmentRepo,
      jobRepo: { findById: async () => null } as any,
      locationRepo: { findById: async () => null } as any,
      workingHoursRepo,
      unavailableBlockRepo: { findByTechnicianAndDateRange: async () => [] } as any,
      travelTimeProvider: new HaversineFallbackProvider(),
      skillMatcher: new StubSkillMatcher(),
    };
    handler = new RescheduleAppointmentExecutionHandler(
      appointmentRepo, assignmentRepo, undefined, undefined, feasibilityDeps,
    );

    const proposal = makeProposal({
      appointmentId: appt.id,
      newScheduledStart: '2026-05-17T12:00:00Z',
      newScheduledEnd: '2026-05-17T13:00:00Z',
    });
    // No sourceContext on proposal so freshness passes automatically.
    const result = await handler.execute(proposal, context) as any;
    expect(result.success).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings.some((w: any) => w.check === 'working_hours')).toBe(true);
  });
});
