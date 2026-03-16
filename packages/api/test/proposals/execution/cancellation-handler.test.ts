import { describe, it, expect, beforeEach } from 'vitest';
import { CancelAppointmentExecutionHandler } from '../../../src/proposals/execution/cancellation-handler';
import { Proposal } from '../../../src/proposals/proposal';
import { InMemoryAppointmentRepository, createAppointment } from '../../../src/appointments/appointment';

describe('P6-014 — Execution for cancellation proposals', () => {
  let handler: CancelAppointmentExecutionHandler;
  let appointmentRepo: InMemoryAppointmentRepository;

  const tenantId = '550e8400-e29b-41d4-a716-446655440000';
  const context = { tenantId, executedBy: 'user-1' };

  function makeProposal(payload: Record<string, unknown>): Proposal {
    return {
      id: 'prop-1',
      tenantId,
      proposalType: 'cancel_appointment',
      status: 'approved',
      payload,
      summary: 'Cancel appointment',
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  beforeEach(() => {
    appointmentRepo = new InMemoryAppointmentRepository();
    handler = new CancelAppointmentExecutionHandler(appointmentRepo);
  });

  it('cancels an appointment', async () => {
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-03-14T09:00:00Z'),
      scheduledEnd: new Date('2026-03-14T11:00:00Z'),
      timezone: 'America/New_York', createdBy: 'user-1',
    }, appointmentRepo);

    const proposal = makeProposal({
      appointmentId: appt.id,
      reason: 'Customer cancelled',
      cancellationType: 'customer_request',
    });

    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(true);

    const updated = await appointmentRepo.findById(tenantId, appt.id);
    expect(updated!.status).toBe('canceled');
  });

  it('rejects missing appointmentId', async () => {
    const proposal = makeProposal({ reason: 'No appointment', cancellationType: 'other' });
    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('appointmentId');
  });

  it('rejects missing reason', async () => {
    const proposal = makeProposal({ appointmentId: 'appt-1' });
    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('reason');
  });

  it('rejects non-existent appointment', async () => {
    const proposal = makeProposal({
      appointmentId: 'nonexistent',
      reason: 'Cancel',
      cancellationType: 'other',
    });
    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(false);
  });

  it('rejects cancelling a completed appointment', async () => {
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-03-14T09:00:00Z'),
      scheduledEnd: new Date('2026-03-14T11:00:00Z'),
      timezone: 'America/New_York', createdBy: 'user-1',
    }, appointmentRepo);

    await appointmentRepo.update(tenantId, appt.id, { status: 'completed' });

    const proposal = makeProposal({
      appointmentId: appt.id,
      reason: 'Too late',
      cancellationType: 'other',
    });
    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot cancel a completed');
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
      reason: 'Cancel',
      cancellationType: 'other',
    });
    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(false);
  });

  it('is idempotent — cancelling already canceled succeeds', async () => {
    const appt = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-03-14T09:00:00Z'),
      scheduledEnd: new Date('2026-03-14T11:00:00Z'),
      timezone: 'America/New_York', createdBy: 'user-1',
    }, appointmentRepo);

    await appointmentRepo.update(tenantId, appt.id, { status: 'canceled' });

    const proposal = makeProposal({
      appointmentId: appt.id,
      reason: 'Already canceled',
      cancellationType: 'other',
    });
    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(true);
  });
});
