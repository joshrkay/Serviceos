import { describe, it, expect } from 'vitest';
import { rescheduleAppointmentPayloadSchema } from '../../../src/proposals/contracts/reschedule';
import { validateProposalPayload } from '../../../src/proposals/contracts';

describe('P6-010 — Appointment reschedule proposal type', () => {
  const validPayload = {
    appointmentId: '550e8400-e29b-41d4-a716-446655440000',
    newScheduledStart: '2026-03-15T09:00:00Z',
    newScheduledEnd: '2026-03-15T11:00:00Z',
  };

  it('validates a valid reschedule payload', () => {
    const result = rescheduleAppointmentPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it('validates with optional arrival window and reason', () => {
    const result = rescheduleAppointmentPayloadSchema.safeParse({
      ...validPayload,
      newArrivalWindowStart: '2026-03-15T08:30:00Z',
      newArrivalWindowEnd: '2026-03-15T09:30:00Z',
      reason: 'Customer requested morning slot',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing newScheduledStart', () => {
    const result = rescheduleAppointmentPayloadSchema.safeParse({
      appointmentId: validPayload.appointmentId,
      newScheduledEnd: validPayload.newScheduledEnd,
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty newScheduledEnd', () => {
    const result = rescheduleAppointmentPayloadSchema.safeParse({
      ...validPayload,
      newScheduledEnd: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid appointmentId', () => {
    const result = rescheduleAppointmentPayloadSchema.safeParse({
      ...validPayload,
      appointmentId: 'not-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('integrates with validateProposalPayload', () => {
    const result = validateProposalPayload('reschedule_appointment', validPayload);
    expect(result.valid).toBe(true);
  });

  it('rejects invalid payload through validateProposalPayload', () => {
    const result = validateProposalPayload('reschedule_appointment', {});
    expect(result.valid).toBe(false);
  });

  it('is idempotent — same input produces same validation result', () => {
    const result1 = validateProposalPayload('reschedule_appointment', validPayload);
    const result2 = validateProposalPayload('reschedule_appointment', validPayload);
    expect(result1).toEqual(result2);
  });
});
