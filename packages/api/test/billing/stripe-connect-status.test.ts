import { describe, it, expect } from 'vitest';
import {
  mapAccountToStatus,
  RESTRICTED_DISABLED_REASONS,
  type StripeAccountSnapshot,
} from '../../src/billing/stripe-connect';

/**
 * D2-2: distinguish 'pending' vs 'restricted' Stripe Connect status.
 *
 * Covers each branch of mapAccountToStatus(account):
 *   - fully active → 'active'
 *   - details_submitted=false (still onboarding) → 'pending'
 *   - disabled_reason='requirements.pending_verification' (user-fixable)
 *     → 'pending'
 *   - disabled_reason='rejected.fraud' (Stripe paused) → 'restricted'
 *   - disabled_reason='under_review' (Stripe risk hold) → 'restricted'
 *   - charges + payouts enabled with null disabled_reason → 'active'
 *   - account.deleted=true → 'disconnected'
 */
describe('mapAccountToStatus (D2-2)', () => {
  it('returns "active" when charges + payouts both enabled', () => {
    const account: StripeAccountSnapshot = {
      id: 'acct_active',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      requirements: { disabled_reason: null, currently_due: [] },
    };
    expect(mapAccountToStatus(account)).toBe('active');
  });

  it('returns "pending" when details_submitted is false', () => {
    // Operator started Connect onboarding but never completed
    // the first KYC form — charges/payouts unset, no disabled_reason.
    const account: StripeAccountSnapshot = {
      id: 'acct_onboarding',
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      requirements: { disabled_reason: null, currently_due: ['business_profile.url'] },
    };
    expect(mapAccountToStatus(account)).toBe('pending');
  });

  it('returns "pending" when disabled_reason is requirements.pending_verification (user-resolvable)', () => {
    // User uploaded docs; Stripe is verifying. Operator can't do
    // anything except wait — but it's not a Stripe-pause situation,
    // so we keep it in the "finish onboarding" bucket.
    const account: StripeAccountSnapshot = {
      id: 'acct_verifying',
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: true,
      requirements: {
        disabled_reason: 'requirements.pending_verification',
        currently_due: [],
      },
    };
    expect(mapAccountToStatus(account)).toBe('pending');
  });

  it('returns "restricted" when disabled_reason is rejected.fraud', () => {
    const account: StripeAccountSnapshot = {
      id: 'acct_rejected',
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: true,
      requirements: { disabled_reason: 'rejected.fraud', currently_due: [] },
    };
    expect(mapAccountToStatus(account)).toBe('restricted');
  });

  it('returns "restricted" when disabled_reason is under_review (Stripe Risk hold)', () => {
    const account: StripeAccountSnapshot = {
      id: 'acct_under_review',
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: true,
      requirements: { disabled_reason: 'under_review', currently_due: [] },
    };
    expect(mapAccountToStatus(account)).toBe('restricted');
  });

  it('returns "active" when disabled_reason is null AND charges + payouts both enabled', () => {
    // Explicit null disabled_reason is the steady-state for a healthy
    // account; we should not let the requirements object trip us up.
    const account: StripeAccountSnapshot = {
      id: 'acct_steady',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      requirements: { disabled_reason: null, currently_due: [] },
    };
    expect(mapAccountToStatus(account)).toBe('active');
  });

  it('returns "disconnected" when account.deleted flag is set', () => {
    // Stripe sends this when the platform deletes the connected
    // account. The id is sometimes still present; the deleted flag
    // takes precedence over everything else.
    const account: StripeAccountSnapshot = {
      id: 'acct_deleted',
      deleted: true,
      charges_enabled: false,
      payouts_enabled: false,
    };
    expect(mapAccountToStatus(account)).toBe('disconnected');
  });

  it('RESTRICTED_DISABLED_REASONS contains exactly the four Stripe-paused reasons', () => {
    // Snapshot guard: if someone widens this set without updating the
    // docs / UX copy, the test forces them to think about it.
    expect(Array.from(RESTRICTED_DISABLED_REASONS).sort()).toEqual(
      [
        'listed',
        'rejected.fraud',
        'rejected.listed',
        'rejected.other',
        'rejected.terms_of_service',
        'under_review',
      ].sort(),
    );
  });
});
