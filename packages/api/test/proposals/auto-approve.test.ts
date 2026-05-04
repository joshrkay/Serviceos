import { describe, it, expect } from 'vitest';
import {
  resolveAutoApproveThreshold,
  shouldAutoApprove,
  DEFAULT_AUTO_APPROVE_THRESHOLDS,
  LEGACY_AUTO_APPROVE_THRESHOLD,
} from '../../src/proposals/auto-approve';
import { decideInitialStatus } from '../../src/proposals/proposal';

describe('P12-004 — resolveAutoApproveThreshold', () => {
  it('returns null when supervisorPresent === false (unsupervised hard-block)', () => {
    expect(
      resolveAutoApproveThreshold({
        supervisorMode: 'supervisor',
        supervisorPresent: false,
      }),
    ).toBeNull();

    expect(
      resolveAutoApproveThreshold({
        supervisorMode: 'tech',
        supervisorPresent: false,
      }),
    ).toBeNull();
  });

  it('returns the legacy 0.9 default when supervisorMode is unset', () => {
    expect(resolveAutoApproveThreshold({})).toBe(LEGACY_AUTO_APPROVE_THRESHOLD);
    expect(resolveAutoApproveThreshold({ supervisorPresent: true })).toBe(
      LEGACY_AUTO_APPROVE_THRESHOLD,
    );
  });

  it('returns the locked per-mode defaults when no override is supplied', () => {
    expect(resolveAutoApproveThreshold({ supervisorMode: 'supervisor' })).toBe(
      DEFAULT_AUTO_APPROVE_THRESHOLDS.supervisor,
    );
    expect(resolveAutoApproveThreshold({ supervisorMode: 'both' })).toBe(
      DEFAULT_AUTO_APPROVE_THRESHOLDS.both,
    );
    expect(resolveAutoApproveThreshold({ supervisorMode: 'tech' })).toBe(
      DEFAULT_AUTO_APPROVE_THRESHOLDS.tech,
    );

    // Sanity: the locked defaults match the values in the plan doc.
    expect(DEFAULT_AUTO_APPROVE_THRESHOLDS.supervisor).toBe(0.9);
    expect(DEFAULT_AUTO_APPROVE_THRESHOLDS.both).toBe(0.92);
    expect(DEFAULT_AUTO_APPROVE_THRESHOLDS.tech).toBe(0.95);
  });

  it('honors per-tenant overrides when present', () => {
    expect(
      resolveAutoApproveThreshold({
        supervisorMode: 'supervisor',
        tenantOverride: { supervisor: 0.85 },
      }),
    ).toBe(0.85);

    // Override only set for one mode — others fall through to defaults.
    expect(
      resolveAutoApproveThreshold({
        supervisorMode: 'tech',
        tenantOverride: { supervisor: 0.85 },
      }),
    ).toBe(DEFAULT_AUTO_APPROVE_THRESHOLDS.tech);
  });

  it('unsupervised hard-block beats every override', () => {
    expect(
      resolveAutoApproveThreshold({
        supervisorMode: 'supervisor',
        supervisorPresent: false,
        tenantOverride: { supervisor: 0.5 }, // very permissive
      }),
    ).toBeNull();
  });

  it('explicit supervisorPresent === true still resolves a number', () => {
    expect(
      resolveAutoApproveThreshold({
        supervisorMode: 'tech',
        supervisorPresent: true,
      }),
    ).toBe(DEFAULT_AUTO_APPROVE_THRESHOLDS.tech);
  });
});

describe('P12-004 — shouldAutoApprove (boundary behavior)', () => {
  it('returns false when threshold is null', () => {
    expect(shouldAutoApprove(0.99, null)).toBe(false);
    expect(shouldAutoApprove(1.0, null)).toBe(false);
  });

  it('returns false when confidence is undefined', () => {
    expect(shouldAutoApprove(undefined, 0.9)).toBe(false);
  });

  it('uses inclusive >= comparison at the boundary', () => {
    expect(shouldAutoApprove(0.9, 0.9)).toBe(true); // exactly at threshold
    expect(shouldAutoApprove(0.95, 0.95)).toBe(true);
    expect(shouldAutoApprove(0.8999, 0.9)).toBe(false);
    expect(shouldAutoApprove(0.91, 0.92)).toBe(false);
  });
});

describe('P12-004 — decideInitialStatus integration via auto-approve', () => {
  // Full integration is exercised via proposal.test.ts; this block
  // ensures the helper matrix is correct from the consumer's POV.
  it('maps the three lock-in modes to the documented status outputs', () => {
    // High confidence (0.96) — should auto-approve in any mode that
    // resolves a threshold below 0.96.
    expect(
      decideInitialStatus({
        proposalType: 'create_customer', // capture-class
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.96,
        supervisorMode: 'supervisor', // threshold 0.90
        supervisorPresent: true,
      }),
    ).toBe('approved');

    expect(
      decideInitialStatus({
        proposalType: 'create_customer',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.96,
        supervisorMode: 'tech', // threshold 0.95
        supervisorPresent: true,
      }),
    ).toBe('approved');

    // Just under tech threshold — same proposal under supervisor mode
    // approves; under tech it stays draft.
    expect(
      decideInitialStatus({
        proposalType: 'create_customer',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.93,
        supervisorMode: 'supervisor',
        supervisorPresent: true,
      }),
    ).toBe('approved');

    expect(
      decideInitialStatus({
        proposalType: 'create_customer',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.93,
        supervisorMode: 'tech',
        supervisorPresent: true,
      }),
    ).toBe('draft');

    // Unsupervised — would-have-auto-approved proposals surface in
    // 'ready_for_review' so the unsupervised-routing worker picks them
    // up. Note this is a Phase-12 behavior change: pre-P12, an
    // autonomous + capture + 0.96 always landed in 'approved' regardless
    // of whether anyone was watching.
    expect(
      decideInitialStatus({
        proposalType: 'create_customer',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.96,
        supervisorMode: 'supervisor',
        supervisorPresent: false,
      }),
    ).toBe('ready_for_review');
  });

  it('preserves pre-Phase-12 behavior when supervisorMode is not threaded', () => {
    // No supervisorMode + no supervisorPresent => legacy 0.9 threshold.
    expect(
      decideInitialStatus({
        proposalType: 'create_customer',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.91,
      }),
    ).toBe('approved');

    expect(
      decideInitialStatus({
        proposalType: 'create_customer',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.89,
      }),
    ).toBe('draft');
  });
});
