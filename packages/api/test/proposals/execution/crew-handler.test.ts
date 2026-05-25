import { describe, it, expect, beforeEach } from 'vitest';
import {
  AddCrewMemberExecutionHandler,
  RemoveCrewMemberExecutionHandler,
} from '../../../src/proposals/execution/crew-handler';
import { Proposal, ProposalType } from '../../../src/proposals/proposal';
import { InMemoryAppointmentRepository, createAppointment } from '../../../src/appointments/appointment';
import { InMemoryAssignmentRepository } from '../../../src/appointments/assignment';
import { FeasibilityDependencies } from '../../../src/scheduling/feasibility-types';
import { StubSkillMatcher } from '../../../src/scheduling/skill-matcher';
import { HaversineFallbackProvider } from '../../../src/scheduling/travel-time/haversine-fallback';

const tenantId = '550e8400-e29b-41d4-a716-446655440000';
const context = { tenantId, executedBy: 'user-1' };

function makeProposal(proposalType: ProposalType, payload: Record<string, unknown>): Proposal {
  return {
    id: 'prop-1', tenantId, proposalType, status: 'approved',
    payload, summary: 'crew change', createdBy: 'user-1',
    createdAt: new Date(), updatedAt: new Date(),
  };
}

function feasibilityDeps(
  appointmentRepo: InMemoryAppointmentRepository,
  assignmentRepo: InMemoryAssignmentRepository,
  workingHoursRepo: any = { findByTechnicianAndDay: async () => null },
): FeasibilityDependencies {
  return {
    assignmentRepo, appointmentRepo,
    jobRepo: { findById: async () => null } as any,
    locationRepo: { findById: async () => null } as any,
    workingHoursRepo,
    unavailableBlockRepo: { findByTechnicianAndDateRange: async () => [] } as any,
    travelTimeProvider: new HaversineFallbackProvider(),
    skillMatcher: new StubSkillMatcher(),
  };
}

describe('AddCrewMemberExecutionHandler', () => {
  let appointmentRepo: InMemoryAppointmentRepository;
  let assignmentRepo: InMemoryAssignmentRepository;

  beforeEach(() => {
    appointmentRepo = new InMemoryAppointmentRepository();
    assignmentRepo = new InMemoryAssignmentRepository();
  });

  it('attaches a non-primary assignment without disturbing the primary', async () => {
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-05-17T10:00:00Z'),
      scheduledEnd: new Date('2026-05-17T11:00:00Z'),
      timezone: 'UTC', createdBy: 'user-1',
    }, appointmentRepo);
    await assignmentRepo.create({
      id: 'as-primary', tenantId, appointmentId: appt.id,
      technicianId: 'tech-primary', isPrimary: true, assignedBy: 'user-1', assignedAt: new Date(),
    });

    const handler = new AddCrewMemberExecutionHandler(appointmentRepo, assignmentRepo);
    const result = await handler.execute(
      makeProposal('add_crew_member', { appointmentId: appt.id, technicianId: 'tech-crew' }),
      context,
    );
    expect(result.success).toBe(true);

    const assignments = await assignmentRepo.findByAppointment(tenantId, appt.id);
    expect(assignments).toHaveLength(2);
    expect(assignments.find((a) => a.technicianId === 'tech-primary')!.isPrimary).toBe(true);
    expect(assignments.find((a) => a.technicianId === 'tech-crew')!.isPrimary).toBe(false);
  });

  it('is idempotent — adding an already-assigned tech does not duplicate', async () => {
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-05-17T10:00:00Z'),
      scheduledEnd: new Date('2026-05-17T11:00:00Z'),
      timezone: 'UTC', createdBy: 'user-1',
    }, appointmentRepo);
    await assignmentRepo.create({
      id: 'as-crew', tenantId, appointmentId: appt.id,
      technicianId: 'tech-crew', isPrimary: false, assignedBy: 'user-1', assignedAt: new Date(),
    });

    const handler = new AddCrewMemberExecutionHandler(appointmentRepo, assignmentRepo);
    const result = await handler.execute(
      makeProposal('add_crew_member', { appointmentId: appt.id, technicianId: 'tech-crew' }),
      context,
    );
    expect(result.success).toBe(true);
    const assignments = await assignmentRepo.findByAppointment(tenantId, appt.id);
    expect(assignments).toHaveLength(1);
  });

  it('rejects when feasibility reports a blocking overlap for the crew tech', async () => {
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-05-17T10:00:00Z'),
      scheduledEnd: new Date('2026-05-17T11:00:00Z'),
      timezone: 'UTC', createdBy: 'user-1',
    }, appointmentRepo);
    // The crew tech is already booked on an overlapping appointment.
    const other = await createAppointment({
      tenantId, jobId: 'job-2',
      scheduledStart: new Date('2026-05-17T10:30:00Z'),
      scheduledEnd: new Date('2026-05-17T11:30:00Z'),
      timezone: 'UTC', createdBy: 'user-1',
    }, appointmentRepo);
    await assignmentRepo.create({
      id: 'as-other', tenantId, appointmentId: other.id,
      technicianId: 'tech-crew', isPrimary: true, assignedBy: 'user-1', assignedAt: new Date(),
    });

    const handler = new AddCrewMemberExecutionHandler(
      appointmentRepo, assignmentRepo, undefined, feasibilityDeps(appointmentRepo, assignmentRepo),
    );
    const result = await handler.execute(
      makeProposal('add_crew_member', { appointmentId: appt.id, technicianId: 'tech-crew' }),
      context,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Overlaps with/);
    expect((await assignmentRepo.findByAppointment(tenantId, appt.id))).toHaveLength(0);
  });

  it('passes feasibility with warnings and surfaces them on the result', async () => {
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-05-17T10:00:00Z'),
      scheduledEnd: new Date('2026-05-17T11:00:00Z'),
      timezone: 'UTC', createdBy: 'user-1',
    }, appointmentRepo);
    const workingHoursRepo = {
      findByTechnicianAndDay: async () => ({
        id: 'wh', tenantId, technicianId: 'tech-crew',
        dayOfWeek: 0, startTime: '14:00', endTime: '17:00', isActive: true,
        createdAt: new Date(), updatedAt: new Date(),
      }),
    };
    const handler = new AddCrewMemberExecutionHandler(
      appointmentRepo, assignmentRepo, undefined,
      feasibilityDeps(appointmentRepo, assignmentRepo, workingHoursRepo),
    );
    const result = await handler.execute(
      makeProposal('add_crew_member', { appointmentId: appt.id, technicianId: 'tech-crew' }),
      context,
    ) as any;
    expect(result.success).toBe(true);
    expect(result.warnings.some((w: any) => w.check === 'working_hours')).toBe(true);
  });

  it('rejects a missing technicianId', async () => {
    const handler = new AddCrewMemberExecutionHandler(appointmentRepo, assignmentRepo);
    const result = await handler.execute(
      makeProposal('add_crew_member', { appointmentId: 'appt-1' }),
      context,
    );
    expect(result.success).toBe(false);
  });
});

describe('RemoveCrewMemberExecutionHandler', () => {
  let appointmentRepo: InMemoryAppointmentRepository;
  let assignmentRepo: InMemoryAssignmentRepository;

  beforeEach(() => {
    appointmentRepo = new InMemoryAppointmentRepository();
    assignmentRepo = new InMemoryAssignmentRepository();
  });

  it('removes a non-primary assignment', async () => {
    await assignmentRepo.create({
      id: 'as-crew', tenantId, appointmentId: 'appt-1',
      technicianId: 'tech-crew', isPrimary: false, assignedBy: 'user-1', assignedAt: new Date(),
    });
    const handler = new RemoveCrewMemberExecutionHandler(appointmentRepo, assignmentRepo);
    const result = await handler.execute(
      makeProposal('remove_crew_member', { appointmentId: 'appt-1', technicianId: 'tech-crew' }),
      context,
    );
    expect(result.success).toBe(true);
    expect(await assignmentRepo.findByAppointment(tenantId, 'appt-1')).toHaveLength(0);
  });

  it('refuses to remove the primary technician', async () => {
    await assignmentRepo.create({
      id: 'as-primary', tenantId, appointmentId: 'appt-1',
      technicianId: 'tech-primary', isPrimary: true, assignedBy: 'user-1', assignedAt: new Date(),
    });
    const handler = new RemoveCrewMemberExecutionHandler(appointmentRepo, assignmentRepo);
    const result = await handler.execute(
      makeProposal('remove_crew_member', { appointmentId: 'appt-1', technicianId: 'tech-primary' }),
      context,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/primary technician/);
    expect(await assignmentRepo.findByAppointment(tenantId, 'appt-1')).toHaveLength(1);
  });

  it('is idempotent when the tech is already absent', async () => {
    const handler = new RemoveCrewMemberExecutionHandler(appointmentRepo, assignmentRepo);
    const result = await handler.execute(
      makeProposal('remove_crew_member', { appointmentId: 'appt-1', technicianId: 'tech-gone' }),
      context,
    );
    expect(result.success).toBe(true);
  });
});
