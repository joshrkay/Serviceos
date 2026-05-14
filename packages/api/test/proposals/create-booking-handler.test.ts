import { describe, it, expect, beforeEach } from 'vitest';
import { CreateBookingExecutionHandler } from '../../src/proposals/execution/create-booking-handler';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createAppointment } from '../../src/appointments/appointment';
import { createProposal } from '../../src/proposals/proposal';

const tenantA = '00000000-0000-4000-8000-00000000000a';

function bookingProposal(appointmentId: string) {
  return createProposal({
    tenantId: tenantA,
    proposalType: 'create_booking',
    payload: { appointmentId },
    summary: 'Book the held slot',
    createdBy: 'agent-1',
  });
}

async function makeHeldAppointment(
  repo: InMemoryAppointmentRepository,
  holdExpiryAt: Date,
) {
  return createAppointment(
    {
      tenantId: tenantA,
      jobId: '00000000-0000-4000-8000-0000000000j1',
      scheduledStart: new Date('2026-06-01T17:00:00Z'),
      scheduledEnd: new Date('2026-06-01T18:00:00Z'),
      timezone: 'UTC',
      createdBy: 'agent-1',
      holdPendingApproval: true,
      holdExpiryAt,
    },
    repo,
  );
}

describe('CreateBookingExecutionHandler', () => {
  let appointmentRepo: InMemoryAppointmentRepository;
  let auditRepo: InMemoryAuditRepository;
  let handler: CreateBookingExecutionHandler;

  beforeEach(() => {
    appointmentRepo = new InMemoryAppointmentRepository();
    auditRepo = new InMemoryAuditRepository();
    handler = new CreateBookingExecutionHandler(appointmentRepo, auditRepo);
  });

  it('has the create_booking proposal type', () => {
    expect(handler.proposalType).toBe('create_booking');
  });

  it('confirms a live held appointment and emits appointment.booked', async () => {
    const appt = await makeHeldAppointment(appointmentRepo, new Date('2099-01-01T00:00:00Z'));
    const result = await handler.execute(bookingProposal(appt.id), {
      tenantId: tenantA,
      executedBy: 'owner-1',
    });

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe(appt.id);

    const confirmed = await appointmentRepo.findById(tenantA, appt.id);
    expect(confirmed?.holdPendingApproval).toBe(false);

    const events = await auditRepo.findByEntity(tenantA, 'appointment', appt.id);
    expect(events.some((e) => e.eventType === 'appointment.booked')).toBe(true);
  });

  it('is idempotent — an already-confirmed appointment still succeeds', async () => {
    const appt = await makeHeldAppointment(appointmentRepo, new Date('2099-01-01T00:00:00Z'));
    const proposal = bookingProposal(appt.id);
    await handler.execute(proposal, { tenantId: tenantA, executedBy: 'owner-1' });
    const second = await handler.execute(proposal, { tenantId: tenantA, executedBy: 'owner-1' });
    expect(second.success).toBe(true);

    // The idempotency early-return exits before the audit-emit block, so a second
    // execution must NOT write a second `appointment.booked` event.
    const events = await auditRepo.findByEntity(tenantA, 'appointment', appt.id);
    const bookedEvents = events.filter((e) => e.eventType === 'appointment.booked');
    expect(bookedEvents).toHaveLength(1);
  });

  it('fails when the hold has expired', async () => {
    const appt = await makeHeldAppointment(appointmentRepo, new Date('2020-01-01T00:00:00Z'));
    const result = await handler.execute(bookingProposal(appt.id), {
      tenantId: tenantA,
      executedBy: 'owner-1',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/expired/i);
  });

  it('fails when the appointment does not exist', async () => {
    const result = await handler.execute(
      bookingProposal('00000000-0000-4000-8000-0000000000zz'),
      { tenantId: tenantA, executedBy: 'owner-1' },
    );
    expect(result.success).toBe(false);
  });

  it('returns success in passthrough mode when no appointmentRepo is wired', async () => {
    const noRepoHandler = new CreateBookingExecutionHandler();
    const result = await noRepoHandler.execute(
      bookingProposal('00000000-0000-4000-8000-0000000000a1'),
      { tenantId: tenantA, executedBy: 'owner-1' },
    );
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe('00000000-0000-4000-8000-0000000000a1');
  });
});
