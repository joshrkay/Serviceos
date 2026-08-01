/**
 * D-018 (WS18c) — autonomous close lane gate matrix.
 *
 * Each reason in order (first-failing wins); the platform kill switch is FIRST;
 * the close cap boundary; the composed D-015 booking ineligibility; the
 * live-session flags LAST; all-pass eligible.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateAutonomousCloseLane,
  autonomousCloseStamp,
  autonomousCloseEvaluationFor,
  type EvaluateAutonomousCloseInput,
} from '../../src/proposals/autonomous-close-lane';

const NOW = new Date('2026-08-03T16:00:00Z');
const FUTURE = new Date(NOW.getTime() + 60 * 60 * 1000);

/** All gates pass — the baseline eligible input. */
function passing(overrides: Partial<EvaluateAutonomousCloseInput> = {}): EvaluateAutonomousCloseInput {
  return {
    platformDisabled: false,
    tenantOptedIn: true,
    closeCapCents: 500000,
    groundedClean: true,
    quoteTotalCents: 185000,
    strictConfirmed: true,
    smsConsentCaptured: true,
    schedulingComplete: true,
    holdPlaced: true,
    holdExpiryAt: FUTURE,
    now: NOW,
    booking: {
      settings: { enabled: true, threshold: 0.95 },
      proposalType: 'create_booking',
      inboundReceptionistSource: true,
      confidenceScore: 0.97,
      payload: { appointmentId: 'appt-1' },
      pendingReferenceCount: 0,
      customerId: 'cust-1',
      holdPlaced: true,
      holdExpiryAt: FUTURE,
      now: NOW,
      slotWithinBusinessHours: true,
    },
    flags: {},
    ...overrides,
  };
}

describe('evaluateAutonomousCloseLane — gate order', () => {
  it('all gates pass → eligible with the composed booking threshold', () => {
    const r = evaluateAutonomousCloseLane(passing());
    expect(r).toEqual({ eligible: true, bookingThreshold: 0.95, closeCapCents: 500000 });
  });

  it('platform kill switch is checked FIRST (even when opted out + every gate would fail)', () => {
    const r = evaluateAutonomousCloseLane(
      passing({ platformDisabled: true, tenantOptedIn: false, groundedClean: false }),
    );
    expect(r).toEqual({ eligible: false, reason: 'platform_disabled' });
  });

  it('tenant_not_opted_in when the platform is live but the tenant is off', () => {
    expect(evaluateAutonomousCloseLane(passing({ tenantOptedIn: false }))).toEqual({
      eligible: false,
      reason: 'tenant_not_opted_in',
    });
  });

  it('quote_not_grounded_clean when any line is uncatalogued/ambiguous', () => {
    expect(evaluateAutonomousCloseLane(passing({ groundedClean: false }))).toEqual({
      eligible: false,
      reason: 'quote_not_grounded_clean',
    });
  });

  it('above_close_cap when the total exceeds the tenant cap (boundary: == cap is allowed)', () => {
    expect(
      evaluateAutonomousCloseLane(passing({ quoteTotalCents: 500001, closeCapCents: 500000 })).eligible,
    ).toBe(false);
    expect(
      evaluateAutonomousCloseLane(passing({ quoteTotalCents: 500001, closeCapCents: 500000 })),
    ).toMatchObject({ reason: 'above_close_cap' });
    // Exactly at the cap → still eligible.
    expect(
      evaluateAutonomousCloseLane(passing({ quoteTotalCents: 500000, closeCapCents: 500000 })).eligible,
    ).toBe(true);
    // No cap configured → the cap gate never fails.
    expect(
      evaluateAutonomousCloseLane(passing({ quoteTotalCents: 9_999_999, closeCapCents: undefined })).eligible,
    ).toBe(true);
  });

  it('not_strict_confirmed when the strict confirmIntent gate did not pass', () => {
    expect(evaluateAutonomousCloseLane(passing({ strictConfirmed: false }))).toEqual({
      eligible: false,
      reason: 'not_strict_confirmed',
    });
  });

  it('sms_consent_not_captured when the on-call TCPA capture failed', () => {
    expect(evaluateAutonomousCloseLane(passing({ smsConsentCaptured: false }))).toEqual({
      eligible: false,
      reason: 'sms_consent_not_captured',
    });
  });

  it('scheduling_incomplete / hold_not_placed / hold_expired', () => {
    expect(evaluateAutonomousCloseLane(passing({ schedulingComplete: false }))).toMatchObject({
      reason: 'scheduling_incomplete',
    });
    expect(evaluateAutonomousCloseLane(passing({ holdPlaced: false }))).toMatchObject({
      reason: 'hold_not_placed',
    });
    expect(
      evaluateAutonomousCloseLane(passing({ holdExpiryAt: new Date(NOW.getTime() - 1000) })),
    ).toMatchObject({ reason: 'hold_expired' });
  });

  it('booking_lane_ineligible surfaces the composed D-015 reason (below booking threshold)', () => {
    const r = evaluateAutonomousCloseLane(
      passing({ booking: { ...passing().booking, confidenceScore: 0.5 } }),
    );
    expect(r).toMatchObject({ eligible: false, reason: 'booking_lane_ineligible', bookingReason: 'below_threshold' });
  });

  it('session_flagged is checked LAST (after the booking lane passes)', () => {
    const r = evaluateAutonomousCloseLane(passing({ flags: { vulnerability: true } }));
    expect(r).toEqual({ eligible: false, reason: 'session_flagged' });
  });
});

describe('autonomousCloseStamp / reader', () => {
  it('round-trips the evaluation through sourceContext', () => {
    const evalResult = evaluateAutonomousCloseLane(passing());
    const stamp = autonomousCloseStamp(evalResult);
    const proposal = { sourceContext: { ...stamp } };
    expect(autonomousCloseEvaluationFor(proposal)).toEqual(evalResult);
  });

  it('reads undefined for a proposal with no stamp', () => {
    expect(autonomousCloseEvaluationFor({ sourceContext: {} })).toBeUndefined();
    expect(autonomousCloseEvaluationFor({})).toBeUndefined();
  });
});
