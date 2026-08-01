import { describe, it, expect } from 'vitest';
import {
  isProposalTypeAllowedOnSurface,
  isSystemSafetyExempt,
} from '../../src/proposals/surface';

/**
 * RIVET P4 — the S1 surface allowlist and the narrow system-safety exemption.
 */
describe('isProposalTypeAllowedOnSurface', () => {
  it('S2/S3/undefined surfaces are unrestricted', () => {
    expect(isProposalTypeAllowedOnSurface('S2', 'send_invoice')).toBe(true);
    expect(isProposalTypeAllowedOnSurface('S3', 'send_invoice')).toBe(true);
    expect(isProposalTypeAllowedOnSurface(undefined, 'send_invoice')).toBe(true);
  });

  it('S1 permits the allowlist and denies operator-only types', () => {
    expect(isProposalTypeAllowedOnSurface('S1', 'create_customer')).toBe(true);
    expect(isProposalTypeAllowedOnSurface('S1', 'reschedule_appointment')).toBe(true);
    expect(isProposalTypeAllowedOnSurface('S1', 'send_invoice')).toBe(false);
    expect(isProposalTypeAllowedOnSurface('S1', 'record_payment')).toBe(false);
    // emergency_dispatch is NOT on the general allowlist…
    expect(isProposalTypeAllowedOnSurface('S1', 'emergency_dispatch')).toBe(false);
  });

  it('S1 permits emergency_dispatch ONLY with the server-set safety marker', () => {
    // …but the deterministic safety path unlocks it via sourceContext.
    expect(
      isProposalTypeAllowedOnSurface('S1', 'emergency_dispatch', {
        systemDetectedSafety: true,
      }),
    ).toBe(true);
  });

  it('the safety marker never unlocks a money/send op', () => {
    // A leaked/forged marker cannot widen reach beyond the exempt set.
    expect(
      isProposalTypeAllowedOnSurface('S1', 'send_invoice', { systemDetectedSafety: true }),
    ).toBe(false);
    expect(
      isProposalTypeAllowedOnSurface('S1', 'record_payment', { systemDetectedSafety: true }),
    ).toBe(false);
  });
});

describe('isSystemSafetyExempt', () => {
  it('true only for an exempt type AND the explicit marker', () => {
    expect(isSystemSafetyExempt('emergency_dispatch', { systemDetectedSafety: true })).toBe(true);
    expect(isSystemSafetyExempt('emergency_dispatch', {})).toBe(false);
    expect(isSystemSafetyExempt('emergency_dispatch', undefined)).toBe(false);
    // A truthy-but-not-true marker does not count.
    expect(
      isSystemSafetyExempt('emergency_dispatch', { systemDetectedSafety: 'yes' as never }),
    ).toBe(false);
    expect(isSystemSafetyExempt('send_invoice', { systemDetectedSafety: true })).toBe(false);
  });
});
