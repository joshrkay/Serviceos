import { describe, it, expect } from 'vitest';
import { reassignAppointmentPayloadSchema } from '../../../src/proposals/contracts/reassignment';
import { validateProposalPayload } from '../../../src/proposals/contracts';

describe('P6-009 — Appointment reassignment proposal type', () => {
  const validPayload = {
    appointmentId: '550e8400-e29b-41d4-a716-446655440000',
    toTechnicianId: '660e8400-e29b-41d4-a716-446655440001',
  };

  it('validates a valid reassignment payload', () => {
    const result = reassignAppointmentPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it('validates with optional fromTechnicianId', () => {
    const result = reassignAppointmentPayloadSchema.safeParse({
      ...validPayload,
      fromTechnicianId: '770e8400-e29b-41d4-a716-446655440002',
      reason: 'Technician unavailable',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid appointmentId', () => {
    const result = reassignAppointmentPayloadSchema.safeParse({
      ...validPayload,
      appointmentId: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing toTechnicianId', () => {
    const result = reassignAppointmentPayloadSchema.safeParse({
      appointmentId: validPayload.appointmentId,
    });
    expect(result.success).toBe(false);
  });

  it('integrates with validateProposalPayload', () => {
    const result = validateProposalPayload('reassign_appointment', validPayload);
    expect(result.valid).toBe(true);
  });

  it('rejects invalid payload through validateProposalPayload', () => {
    const result = validateProposalPayload('reassign_appointment', { appointmentId: 'bad' });
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
  });

  it('is idempotent — same input produces same validation result', () => {
    const result1 = validateProposalPayload('reassign_appointment', validPayload);
    const result2 = validateProposalPayload('reassign_appointment', validPayload);
    expect(result1).toEqual(result2);
  });
});
