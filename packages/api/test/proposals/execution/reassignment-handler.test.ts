import { describe, it, expect, beforeEach } from 'vitest';
import { ReassignAppointmentExecutionHandler } from '../../../src/proposals/execution/reassignment-handler';
import { Proposal } from '../../../src/proposals/proposal';
import { InMemoryAppointmentRepository, createAppointment } from '../../../src/appointments/appointment';
import { InMemoryAssignmentRepository, assignTechnician } from '../../../src/appointments/assignment';
import { InMemoryDispatchAnalyticsRepository } from '../../../src/dispatch/analytics';
import { FeasibilityDependencies } from '../../../src/scheduling/feasibility-types';
import { StubSkillMatcher } from '../../../src/scheduling/skill-matcher';
import { HaversineFallbackProvider } from '../../../src/scheduling/travel-time/haversine-fallback';

describe('P6-012 — Execution for reassignment proposals', () => {
  let handler: ReassignAppointmentExecutionHandler;
  let appointmentRepo: InMemoryAppointmentRepository;
  let assignmentRepo: InMemoryAssignmentRepository;

  const tenantId = '550e8400-e29b-41d4-a716-446655440000';
  const techA = '660e8400-e29b-41d4-a716-446655440001';
  const techB = '770e8400-e29b-41d4-a716-446655440002';
  const context = { tenantId, executedBy: 'user-1' };

  function makeProposal(payload: Record<string, unknown>): Proposal {
    return {
      id: 'prop-1',
      tenantId,
      proposalType: 'reassign_appointment',
      status: 'approved',
      payload,
      summary: 'Reassign appointment',
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  beforeEach(() => {
    appointmentRepo = new InMemoryAppointmentRepository();
    assignmentRepo = new InMemoryAssignmentRepository();
    handler = new ReassignAppointmentExecutionHandler(appointmentRepo, assignmentRepo);
  });

  it('reassigns appointment to new technician', async () => {
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-03-14T09:00:00Z'),
      scheduledEnd: new Date('2026-03-14T11:00:00Z'),
      timezone: 'America/New_York', createdBy: 'user-1',
    }, appointmentRepo);

    const proposal = makeProposal({
      appointmentId: appt.id,
      toTechnicianId: techA,
    });

    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();

    const assignments = await assignmentRepo.findByAppointment(tenantId, appt.id);
    expect(assignments).toHaveLength(1);
    expect(assignments[0].technicianId).toBe(techA);
  });

  it('removes old assignment and creates new one', async () => {
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-03-14T09:00:00Z'),
      scheduledEnd: new Date('2026-03-14T11:00:00Z'),
      timezone: 'America/New_York', createdBy: 'user-1',
    }, appointmentRepo);

    await assignTechnician({
      tenantId, appointmentId: appt.id, technicianId: techA,
      technicianRole: 'technician', isPrimary: true, assignedBy: 'user-1',
    }, assignmentRepo);

    const proposal = makeProposal({
      appointmentId: appt.id,
      fromTechnicianId: techA,
      toTechnicianId: techB,
    });

    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(true);

    const assignments = await assignmentRepo.findByAppointment(tenantId, appt.id);
    expect(assignments).toHaveLength(1);
    expect(assignments[0].technicianId).toBe(techB);
  });

  it('rejects missing appointmentId', async () => {
    const proposal = makeProposal({ toTechnicianId: techA });
    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('appointmentId');
  });

  it('rejects missing toTechnicianId', async () => {
    const proposal = makeProposal({ appointmentId: 'appt-1' });
    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('toTechnicianId');
  });

  it('rejects non-existent appointment', async () => {
    const proposal = makeProposal({
      appointmentId: 'nonexistent',
      toTechnicianId: techA,
    });
    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
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
      toTechnicianId: techA,
    });
    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(false);
  });

  it('is idempotent — reassigning to same technician returns existing', async () => {
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-03-14T09:00:00Z'),
      scheduledEnd: new Date('2026-03-14T11:00:00Z'),
      timezone: 'America/New_York', createdBy: 'user-1',
    }, appointmentRepo);

    await assignTechnician({
      tenantId, appointmentId: appt.id, technicianId: techA,
      technicianRole: 'technician', isPrimary: true, assignedBy: 'user-1',
    }, assignmentRepo);

    const proposal = makeProposal({
      appointmentId: appt.id,
      toTechnicianId: techA,
    });

    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(true);

    const assignments = await assignmentRepo.findByAppointment(tenantId, appt.id);
    expect(assignments).toHaveLength(1);
  });

  describe('P6-022B — dispatch analytics capture on reassignment', () => {
    it('records a "reassigned" DispatchMetric when the analytics repo is wired', async () => {
      const analyticsRepo = new InMemoryDispatchAnalyticsRepository();
      const handlerWithAnalytics = new ReassignAppointmentExecutionHandler(
        appointmentRepo,
        assignmentRepo,
        analyticsRepo
      );

      const appt = await createAppointment(
        {
          tenantId,
          jobId: 'job-1',
          scheduledStart: new Date('2026-03-14T09:00:00Z'),
          scheduledEnd: new Date('2026-03-14T11:00:00Z'),
          timezone: 'America/New_York',
          createdBy: 'user-1',
        },
        appointmentRepo
      );
      await assignTechnician(
        {
          tenantId,
          appointmentId: appt.id,
          technicianId: techA,
          technicianRole: 'technician',
          isPrimary: true,
          assignedBy: 'user-1',
        },
        assignmentRepo
      );

      const proposal = makeProposal({
        appointmentId: appt.id,
        toTechnicianId: techB,
      });

      const result = await handlerWithAnalytics.execute(proposal, context);
      expect(result.success).toBe(true);

      const metrics = await analyticsRepo.getMetricsByType(tenantId, 'reassigned');
      expect(metrics).toHaveLength(1);
      expect(metrics[0].appointmentId).toBe(appt.id);
      expect(metrics[0].technicianId).toBe(techB);
      expect(metrics[0].metadata?.proposalId).toBe(proposal.id);
    });

    it('does not record a metric when the analytics repo is not supplied', async () => {
      const appt = await createAppointment(
        {
          tenantId,
          jobId: 'job-2',
          scheduledStart: new Date('2026-03-14T09:00:00Z'),
          scheduledEnd: new Date('2026-03-14T11:00:00Z'),
          timezone: 'America/New_York',
          createdBy: 'user-1',
        },
        appointmentRepo
      );
      await assignTechnician(
        {
          tenantId,
          appointmentId: appt.id,
          technicianId: techA,
          technicianRole: 'technician',
          isPrimary: true,
          assignedBy: 'user-1',
        },
        assignmentRepo
      );

      const proposal = makeProposal({
        appointmentId: appt.id,
        toTechnicianId: techB,
      });

      // handler here has no analyticsRepo — smoke-test it still works.
      const result = await handler.execute(proposal, context);
      expect(result.success).toBe(true);
    });
  });

  it('rejects when feasibility reports a blocking overlap', async () => {
    const localAssignmentRepo = new InMemoryAssignmentRepository();
    // Appointment to be reassigned to techB
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-05-17T10:00:00Z'),
      scheduledEnd: new Date('2026-05-17T11:00:00Z'),
      timezone: 'UTC', createdBy: 'user-1',
    }, appointmentRepo);
    // techA currently holds this appointment (for freshness check)
    await localAssignmentRepo.create({
      id: 'as-1', tenantId, appointmentId: appt.id,
      technicianId: techA, isPrimary: true, assignedBy: 'user-1', assignedAt: new Date(),
    });
    // techB already has a conflicting appointment at the same time
    const conflict = await createAppointment({
      tenantId, jobId: 'job-2',
      scheduledStart: new Date('2026-05-17T10:30:00Z'),
      scheduledEnd: new Date('2026-05-17T11:30:00Z'),
      timezone: 'UTC', createdBy: 'user-1',
    }, appointmentRepo);
    await localAssignmentRepo.create({
      id: 'as-2', tenantId, appointmentId: conflict.id,
      technicianId: techB, isPrimary: true, assignedBy: 'user-1', assignedAt: new Date(),
    });

    const feasibilityDeps: FeasibilityDependencies = {
      assignmentRepo: localAssignmentRepo, appointmentRepo,
      jobRepo: { findById: async () => null } as any,
      locationRepo: { findById: async () => null } as any,
      workingHoursRepo: { findByTechnicianAndDay: async () => null } as any,
      unavailableBlockRepo: { findByTechnicianAndDateRange: async () => [] } as any,
      travelTimeProvider: new HaversineFallbackProvider(),
      skillMatcher: new StubSkillMatcher(),
    };
    const handlerWithFeasibility = new ReassignAppointmentExecutionHandler(
      appointmentRepo, localAssignmentRepo, undefined, feasibilityDeps,
    );

    const proposal = makeProposal({
      appointmentId: appt.id,
      fromTechnicianId: techA,
      toTechnicianId: techB,
    });
    const result = await handlerWithFeasibility.execute(proposal, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Overlaps with/);
  });

  it('passes feasibility (warnings only) and surfaces them on the result', async () => {
    const localAssignmentRepo = new InMemoryAssignmentRepository();
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-05-17T10:00:00Z'),
      scheduledEnd: new Date('2026-05-17T11:00:00Z'),
      timezone: 'UTC', createdBy: 'user-1',
    }, appointmentRepo);
    await localAssignmentRepo.create({
      id: 'as-1', tenantId, appointmentId: appt.id,
      technicianId: techA, isPrimary: true, assignedBy: 'user-1', assignedAt: new Date(),
    });

    // Inject a working-hours mock that triggers an "outside working hours" warning for techB.
    const workingHoursRepo: any = {
      findByTechnicianAndDay: async () => ({
        id: 'wh', tenantId, technicianId: techB,
        dayOfWeek: 0, startTime: '14:00', endTime: '17:00', isActive: true,
        createdAt: new Date(), updatedAt: new Date(),
      }),
    };
    const feasibilityDeps: FeasibilityDependencies = {
      assignmentRepo: localAssignmentRepo, appointmentRepo,
      jobRepo: { findById: async () => null } as any,
      locationRepo: { findById: async () => null } as any,
      workingHoursRepo,
      unavailableBlockRepo: { findByTechnicianAndDateRange: async () => [] } as any,
      travelTimeProvider: new HaversineFallbackProvider(),
      skillMatcher: new StubSkillMatcher(),
    };
    const handlerWithFeasibility = new ReassignAppointmentExecutionHandler(
      appointmentRepo, localAssignmentRepo, undefined, feasibilityDeps,
    );

    const proposal = makeProposal({
      appointmentId: appt.id,
      fromTechnicianId: techA,
      toTechnicianId: techB,
    });
    const result = await handlerWithFeasibility.execute(proposal, context) as any;
    expect(result.success).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings.some((w: any) => w.check === 'working_hours')).toBe(true);
  });
});
