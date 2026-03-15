import { describe, it, expect, beforeEach } from 'vitest';
import { ReassignAppointmentExecutionHandler } from '../../../src/proposals/execution/reassignment-handler';
import { Proposal } from '../../../src/proposals/proposal';
import { InMemoryAppointmentRepository, createAppointment } from '../../../src/appointments/appointment';
import { InMemoryAssignmentRepository, assignTechnician } from '../../../src/appointments/assignment';

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
});
