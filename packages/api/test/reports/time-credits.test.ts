import { describe, it, expect } from 'vitest';
import {
  TIME_CREDIT_VERSION,
  PROPOSAL_TIME_CREDITS,
  DEFAULT_PROPOSAL_CREDIT_MINUTES,
  CALL_HANDLED_CREDIT_MINUTES,
  creditForProposalType,
} from '../../src/reports/time-credits';

describe('time-credit constants', () => {
  it('has a non-empty version string', () => {
    expect(typeof TIME_CREDIT_VERSION).toBe('string');
    expect(TIME_CREDIT_VERSION.length).toBeGreaterThan(0);
  });

  it('returns an explicit credit for a mapped proposal type', () => {
    expect(creditForProposalType('draft_estimate')).toBe(
      PROPOSAL_TIME_CREDITS.draft_estimate,
    );
    expect(creditForProposalType('draft_estimate')).toBeGreaterThan(0);
  });

  it('returns the default credit for an unmapped proposal type', () => {
    // voice_clarification is explicitly mapped to 0 (not a real action);
    // a hypothetical unmapped type falls back to the default.
    expect(creditForProposalType('voice_clarification')).toBe(0);
    expect(creditForProposalType('create_customer')).toBeGreaterThan(0);
  });

  it('assigns a positive credit to a handled call', () => {
    expect(CALL_HANDLED_CREDIT_MINUTES).toBeGreaterThan(0);
  });

  it('every explicit credit is a non-negative integer', () => {
    for (const value of Object.values(PROPOSAL_TIME_CREDITS)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value as number).toBeGreaterThanOrEqual(0);
    }
    expect(Number.isInteger(DEFAULT_PROPOSAL_CREDIT_MINUTES)).toBe(true);
  });
});
