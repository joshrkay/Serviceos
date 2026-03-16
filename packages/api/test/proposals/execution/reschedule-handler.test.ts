import { describe, it, expect, beforeEach } from 'vitest';
import { RescheduleAppointmentExecutionHandler } from '../../../src/proposals/execution/reschedule-handler';
import { Proposal } from '../../../src/proposals/proposal';
import { InMemoryAppointmentRepository, createAppointment } from '../../../src/appointments/appointment';

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
});
