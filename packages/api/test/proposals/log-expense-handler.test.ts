import { describe, it, expect } from 'vitest';
import {
  VALID_PROPOSAL_TYPES,
  actionClassForProposalType,
} from '../../src/proposals/proposal';
import { validateProposalPayload } from '../../src/proposals/contracts';

describe('log_expense proposal type', () => {
  it('is a valid proposal type classified as capture', () => {
    expect(VALID_PROPOSAL_TYPES).toContain('log_expense');
    expect(actionClassForProposalType('log_expense')).toBe('capture');
  });

  it('accepts a well-formed payload', () => {
    const result = validateProposalPayload('log_expense', {
      description: '$240 at the supply house',
      amountCents: 24000,
      category: 'materials',
      spentAt: '2026-05-10',
      jobId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a payload with a fractional amount', () => {
    const result = validateProposalPayload('log_expense', {
      description: 'fuel',
      amountCents: 12.5,
      category: 'fuel',
      spentAt: '2026-05-10',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a payload with an unknown category', () => {
    const result = validateProposalPayload('log_expense', {
      description: 'mystery',
      amountCents: 100,
      category: 'snacks',
      spentAt: '2026-05-10',
    });
    expect(result.valid).toBe(false);
  });
});
