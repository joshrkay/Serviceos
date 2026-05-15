import { describe, it, expect, beforeEach } from 'vitest';
import { RescheduleAppointmentExecutionHandler } from '../../src/proposals/execution/reschedule-handler';
import { CancelAppointmentExecutionHandler } from '../../src/proposals/execution/cancellation-handler';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createAppointment } from '../../src/appointments/appointment';
import { createProposal } from '../../src/proposals/proposal';

const tenantA = '00000000-0000-4000-8000-00000000000a';

async function scheduledAppointment(repo: InMemoryAppointmentRepository) {
  return createAppointment(
    {
      tenantId: tenantA,
      jobId: '00000000-0000-4000-8000-0000000000j1',
      scheduledStart: new Date('2026-06-01T17:00:00Z'),
      scheduledEnd: new Date('2026-06-01T18:00:00Z'),
      timezone: 'UTC',
      createdBy: 'agent-1',
    },
    repo,
  );
}

describe('schedule-mutation audit events', () => {
  let appointmentRepo: InMemoryAppointmentRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    appointmentRepo = new InMemoryAppointmentRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  it('reschedule handler emits an appointment.rescheduled audit event', async () => {
    const appt = await scheduledAppointment(appointmentRepo);
    const handler = new RescheduleAppointmentExecutionHandler(
      appointmentRepo,
      undefined,
      undefined,
      auditRepo,
    );
    const proposal = createProposal({
      tenantId: tenantA,
      proposalType: 'reschedule_appointment',
      payload: {
        appointmentId: appt.id,
        newScheduledStart: '2026-06-02T17:00:00Z',
        newScheduledEnd: '2026-06-02T18:00:00Z',
      },
      summary: 'Reschedule',
      createdBy: 'agent-1',
    });

    const result = await handler.execute(proposal, { tenantId: tenantA, executedBy: 'owner-1' });
    expect(result.success).toBe(true);

    const events = await auditRepo.findByEntity(tenantA, 'appointment', appt.id);
    expect(events.some((e) => e.eventType === 'appointment.rescheduled')).toBe(true);

    const rescheduled = events.find((e) => e.eventType === 'appointment.rescheduled');
    expect(rescheduled?.metadata).toMatchObject({
      proposalId: proposal.id,
      oldScheduledStart: '2026-06-01T17:00:00.000Z',
      oldScheduledEnd: '2026-06-01T18:00:00.000Z',
      newScheduledStart: '2026-06-02T17:00:00Z',
      newScheduledEnd: '2026-06-02T18:00:00Z',
    });
  });

  it('cancel handler emits an appointment.canceled audit event', async () => {
    const appt = await scheduledAppointment(appointmentRepo);
    const handler = new CancelAppointmentExecutionHandler(
      appointmentRepo,
      undefined,
      auditRepo,
    );
    const proposal = createProposal({
      tenantId: tenantA,
      proposalType: 'cancel_appointment',
      payload: {
        appointmentId: appt.id,
        reason: 'customer_request',
        cancellationType: 'customer_request',
      },
      summary: 'Cancel',
      createdBy: 'agent-1',
    });

    const result = await handler.execute(proposal, { tenantId: tenantA, executedBy: 'owner-1' });
    expect(result.success).toBe(true);

    const events = await auditRepo.findByEntity(tenantA, 'appointment', appt.id);
    expect(events.some((e) => e.eventType === 'appointment.canceled')).toBe(true);
  });
});
