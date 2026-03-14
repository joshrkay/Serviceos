import { describe, it, expect } from 'vitest';
import { cancelAppointmentPayloadSchema } from '../../../src/proposals/contracts/cancellation';
import { validateProposalPayload } from '../../../src/proposals/contracts';

describe('P6-011 — Appointment cancellation proposal type', () => {
  const validPayload = {
    appointmentId: '550e8400-e29b-41d4-a716-446655440000',
    reason: 'Customer no longer needs service',
    cancellationType: 'customer_request' as const,
  };

  it('validates a valid cancellation payload', () => {
    const result = cancelAppointmentPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it('validates all cancellation types', () => {
    const types = ['customer_request', 'technician_unavailable', 'scheduling_conflict', 'other'] as const;
    for (const cancellationType of types) {
      const result = cancelAppointmentPayloadSchema.safeParse({
        ...validPayload,
        cancellationType,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects missing reason', () => {
    const result = cancelAppointmentPayloadSchema.safeParse({
      appointmentId: validPayload.appointmentId,
      cancellationType: 'customer_request',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty reason', () => {
    const result = cancelAppointmentPayloadSchema.safeParse({
      ...validPayload,
      reason: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid cancellation type', () => {
    const result = cancelAppointmentPayloadSchema.safeParse({
      ...validPayload,
      cancellationType: 'invalid_type',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid appointmentId', () => {
    const result = cancelAppointmentPayloadSchema.safeParse({
      ...validPayload,
      appointmentId: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('integrates with validateProposalPayload', () => {
    const result = validateProposalPayload('cancel_appointment', validPayload);
    expect(result.valid).toBe(true);
  });

  it('rejects invalid payload through validateProposalPayload', () => {
    const result = validateProposalPayload('cancel_appointment', {});
    expect(result.valid).toBe(false);
  });

  it('is idempotent — same input produces same validation result', () => {
    const result1 = validateProposalPayload('cancel_appointment', validPayload);
    const result2 = validateProposalPayload('cancel_appointment', validPayload);
    expect(result1).toEqual(result2);
  });
});
