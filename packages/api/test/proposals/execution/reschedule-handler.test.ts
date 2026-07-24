import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RescheduleAppointmentExecutionHandler } from '../../../src/proposals/execution/reschedule-handler';
import { Proposal } from '../../../src/proposals/proposal';
import type { TransactionalCommsService } from '../../../src/notifications/transactional-comms-service';
import { InMemoryAppointmentRepository, createAppointment } from '../../../src/appointments/appointment';
import { FeasibilityDependencies } from '../../../src/scheduling/feasibility-types';
import { StubSkillMatcher } from '../../../src/scheduling/skill-matcher';
import { HaversineFallbackProvider } from '../../../src/scheduling/travel-time/haversine-fallback';
import { InMemoryAssignmentRepository } from '../../../src/appointments/assignment';
import { getDispatchBoardEventBus } from '../../../src/dispatch/board-event-bus';

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

  it('Codex P2 (PR #705) — passes the proposal id (not the destination timestamp) as the reschedule notification occurrence token', async () => {
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-03-14T09:00:00Z'),
      scheduledEnd: new Date('2026-03-14T11:00:00Z'),
      timezone: 'America/New_York', createdBy: 'user-1',
    }, appointmentRepo);

    const notifyRescheduled = vi.fn().mockResolvedValue(undefined);
    const comms = { notifyRescheduled } as unknown as TransactionalCommsService;
    const handlerWithComms = new RescheduleAppointmentExecutionHandler(
      appointmentRepo, undefined, undefined, undefined, undefined, comms,
    );

    const proposal = makeProposal({
      appointmentId: appt.id,
      newScheduledStart: '2026-03-15T10:00:00Z',
      newScheduledEnd: '2026-03-15T12:00:00Z',
    });

    const result = await handlerWithComms.execute(proposal, context);
    expect(result.success).toBe(true);
    // Per-ACTION token = proposal id, NOT the destination timestamp: moving to
    // a slot, away, then back reuses the timestamp and would drop the final
    // notification as a duplicate against the prior claim's tombstone.
    expect(notifyRescheduled).toHaveBeenCalledWith(tenantId, appt.id, 'prop-1');
    expect(notifyRescheduled).not.toHaveBeenCalledWith(tenantId, appt.id, '2026-03-15T10:00:00Z');
  });

  it('refreshes both the old and new day boards on a cross-day move', async () => {
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-03-14T09:00:00Z'),
      scheduledEnd: new Date('2026-03-14T11:00:00Z'),
      timezone: 'America/New_York', createdBy: 'user-1',
    }, appointmentRepo);

    const seen: string[] = [];
    const bus = getDispatchBoardEventBus();
    const unsubOld = bus.subscribe(tenantId, '2026-03-14', (e) => { if (e.type === 'board_updated') seen.push(e.date); });
    const unsubNew = bus.subscribe(tenantId, '2026-03-15', (e) => { if (e.type === 'board_updated') seen.push(e.date); });

    await handler.execute(
      makeProposal({
        appointmentId: appt.id,
        newScheduledStart: '2026-03-15T10:00:00Z',
        newScheduledEnd: '2026-03-15T12:00:00Z',
      }),
      context,
    );
    unsubOld();
    unsubNew();
    expect(seen).toContain('2026-03-14');
    expect(seen).toContain('2026-03-15');
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

  // ── RIVET P4 — S1 ownership binding ("reschedule OWN appointment" only) ──

  function s1Proposal(payload: Record<string, unknown>, callerCustomerId?: string): Proposal {
    return {
      ...makeProposal(payload),
      sourceContext: {
        source: 'calling-agent',
        channel: 'telephony',
        surface: 'S1',
        ...(callerCustomerId ? { callerCustomerId } : {}),
      },
    };
  }

  function feasibilityWithJobCustomer(customerId: string | null): FeasibilityDependencies {
    return {
      assignmentRepo: new InMemoryAssignmentRepository(),
      appointmentRepo,
      jobRepo: {
        findById: async () =>
          customerId ? ({ id: 'job-1', tenantId, customerId } as any) : null,
      } as any,
      locationRepo: { findById: async () => null } as any,
      workingHoursRepo: { findByTechnicianAndDay: async () => null } as any,
      unavailableBlockRepo: { findByTechnicianAndDateRange: async () => [] } as any,
      travelTimeProvider: new HaversineFallbackProvider(),
      skillMatcher: new StubSkillMatcher(),
    };
  }

  const S1_TIMES = {
    newScheduledStart: '2026-03-15T10:00:00Z',
    newScheduledEnd: '2026-03-15T12:00:00Z',
  };

  it("S1: REFUSES to move an appointment that is not the caller's own", async () => {
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-03-14T09:00:00Z'),
      scheduledEnd: new Date('2026-03-14T11:00:00Z'),
      timezone: 'UTC', createdBy: 'user-1',
    }, appointmentRepo);
    const s1Handler = new RescheduleAppointmentExecutionHandler(
      appointmentRepo, undefined, undefined, undefined,
      feasibilityWithJobCustomer('cust-somebody-else'),
    );

    const result = await s1Handler.execute(
      s1Proposal({ appointmentId: appt.id, ...S1_TIMES }, 'cust-caller'),
      context,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not belong to the caller/);
    // The appointment did NOT move.
    const unchanged = await appointmentRepo.findById(tenantId, appt.id);
    expect(unchanged!.scheduledStart.toISOString()).toBe('2026-03-14T09:00:00.000Z');
  });

  it("S1: allows moving the caller's OWN appointment", async () => {
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-03-14T09:00:00Z'),
      scheduledEnd: new Date('2026-03-14T11:00:00Z'),
      timezone: 'UTC', createdBy: 'user-1',
    }, appointmentRepo);
    const s1Handler = new RescheduleAppointmentExecutionHandler(
      appointmentRepo, undefined, undefined, undefined,
      feasibilityWithJobCustomer('cust-caller'),
    );

    const result = await s1Handler.execute(
      s1Proposal({ appointmentId: appt.id, ...S1_TIMES }, 'cust-caller'),
      context,
    );
    expect(result.success).toBe(true);
    const moved = await appointmentRepo.findById(tenantId, appt.id);
    expect(moved!.scheduledStart.toISOString()).toBe('2026-03-15T10:00:00.000Z');
  });

  it('S1: fails closed when the caller was never identified (no callerCustomerId)', async () => {
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-03-14T09:00:00Z'),
      scheduledEnd: new Date('2026-03-14T11:00:00Z'),
      timezone: 'UTC', createdBy: 'user-1',
    }, appointmentRepo);
    const s1Handler = new RescheduleAppointmentExecutionHandler(
      appointmentRepo, undefined, undefined, undefined,
      feasibilityWithJobCustomer('cust-caller'),
    );

    const result = await s1Handler.execute(
      s1Proposal({ appointmentId: appt.id, ...S1_TIMES }),
      context,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/identity was not verified/);
  });

  it('S1: fails closed when ownership cannot be verified (no job lookup / no job)', async () => {
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-03-14T09:00:00Z'),
      scheduledEnd: new Date('2026-03-14T11:00:00Z'),
      timezone: 'UTC', createdBy: 'user-1',
    }, appointmentRepo);

    // No feasibilityDeps at all → no jobRepo to verify with.
    const noDeps = new RescheduleAppointmentExecutionHandler(appointmentRepo);
    const r1 = await noDeps.execute(
      s1Proposal({ appointmentId: appt.id, ...S1_TIMES }, 'cust-caller'),
      context,
    );
    expect(r1.success).toBe(false);
    expect(r1.error).toMatch(/Cannot verify appointment ownership/);

    // jobRepo wired but the job row is missing → also refused.
    const missingJob = new RescheduleAppointmentExecutionHandler(
      appointmentRepo, undefined, undefined, undefined,
      feasibilityWithJobCustomer(null),
    );
    const r2 = await missingJob.execute(
      s1Proposal({ appointmentId: appt.id, ...S1_TIMES }, 'cust-caller'),
      context,
    );
    expect(r2.success).toBe(false);
    expect(r2.error).toMatch(/does not belong to the caller/);
  });

  it('S2/unstamped proposals are unaffected by the ownership guard', async () => {
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-03-14T09:00:00Z'),
      scheduledEnd: new Date('2026-03-14T11:00:00Z'),
      timezone: 'UTC', createdBy: 'user-1',
    }, appointmentRepo);
    // Plain handler with no feasibility deps — the pre-existing operator path.
    const result = await handler.execute(
      makeProposal({ appointmentId: appt.id, ...S1_TIMES }),
      context,
    );
    expect(result.success).toBe(true);
  });
});
