import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CreateAppointmentExecutionHandler } from '../../../src/proposals/execution/handlers';
import { Proposal } from '../../../src/proposals/proposal';
import { InMemoryAppointmentRepository, createAppointment } from '../../../src/appointments/appointment';
import { InMemoryAssignmentRepository, assignTechnician } from '../../../src/appointments/assignment';

describe('CreateAppointmentExecutionHandler', () => {
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';
  const techId = '660e8400-e29b-41d4-a716-446655440001';
  const context = { tenantId, executedBy: 'user-1' };
  let appointmentRepo: InMemoryAppointmentRepository;
  let assignmentRepo: InMemoryAssignmentRepository;
  const enqueue = vi.fn(async () => {});

  function makeProposal(payload: Record<string, unknown>): Proposal {
    return {
      id: 'prop-1',
      tenantId,
      proposalType: 'create_appointment',
      status: 'approved',
      payload,
      summary: 'Create appointment',
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  beforeEach(() => {
    appointmentRepo = new InMemoryAppointmentRepository();
    assignmentRepo = new InMemoryAssignmentRepository();
    enqueue.mockClear();
  });

  it('creates appointment, assigns technician, and enqueues confirmation notifications', async () => {
    const handler = new CreateAppointmentExecutionHandler(
      appointmentRepo,
      assignmentRepo,
      { enqueue },
    );

    const proposal = makeProposal({
      jobId: '11111111-1111-4111-8111-111111111111',
      scheduledStart: '2026-04-20T14:00:00Z',
      scheduledEnd: '2026-04-20T15:00:00Z',
      technicianId: techId,
      notificationChannels: ['sms', 'email'],
    });

    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();

    const created = await appointmentRepo.findById(tenantId, result.resultEntityId!);
    expect(created).not.toBeNull();

    const assignments = await assignmentRepo.findByAppointment(tenantId, result.resultEntityId!);
    expect(assignments).toHaveLength(1);
    expect(assignments[0].technicianId).toBe(techId);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      tenantId,
      appointmentId: result.resultEntityId,
      channels: ['sms', 'email'],
    }));
  });

  it('blocks overlapping technician slots', async () => {
    const handler = new CreateAppointmentExecutionHandler(
      appointmentRepo,
      assignmentRepo,
      { enqueue },
    );

    const existing = await createAppointment({
      tenantId,
      jobId: '22222222-2222-4222-8222-222222222222',
      scheduledStart: new Date('2026-04-20T14:00:00Z'),
      scheduledEnd: new Date('2026-04-20T15:00:00Z'),
      timezone: 'UTC',
      createdBy: 'user-1',
    }, appointmentRepo);
    await assignTechnician({
      tenantId,
      appointmentId: existing.id,
      technicianId: techId,
      technicianRole: 'technician',
      assignedBy: 'user-1',
    }, assignmentRepo);

    const proposal = makeProposal({
      jobId: '33333333-3333-4333-8333-333333333333',
      scheduledStart: '2026-04-20T14:30:00Z',
      scheduledEnd: '2026-04-20T15:30:00Z',
      technicianId: techId,
    });

    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Overlaps with appointment');
    expect(enqueue).not.toHaveBeenCalled();
  });
});

