import { describe, it, expect } from 'vitest';
import { validateProposalPayload } from '../../src/proposals/contracts';
import { actionClassForProposalType, VALID_PROPOSAL_TYPES } from '../../src/proposals/proposal';

const validAppointmentId = '00000000-0000-4000-8000-0000000000a1';

describe('create_booking proposal type', () => {
  it('is a recognized proposal type', () => {
    expect(VALID_PROPOSAL_TYPES).toContain('create_booking');
  });

  it('is classified as a capture-class action', () => {
    expect(actionClassForProposalType('create_booking')).toBe('capture');
  });

  it('accepts a payload with a valid appointmentId', () => {
    const result = validateProposalPayload('create_booking', {
      appointmentId: validAppointmentId,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a payload missing appointmentId', () => {
    const result = validateProposalPayload('create_booking', {});
    expect(result.valid).toBe(false);
  });

  it('rejects a payload with a non-uuid appointmentId', () => {
    const result = validateProposalPayload('create_booking', {
      appointmentId: 'not-a-uuid',
    });
    expect(result.valid).toBe(false);
  });
});
