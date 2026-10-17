/**
 * UB-D / D-015 — Autonomous booking lane.
 *
 * Two suites:
 *  1. The pure evaluator: every gate independently blocks, first-failing
 *     reason wins, threshold floor is enforced in code.
 *  2. decideInitialStatus integration: the lane input only ever acts inside
 *     the unsupervised `autonomous + capture` branch, and its ABSENCE is
 *     byte-identical to pre-lane behavior across the full proposal-type ×
 *     trust-tier × supervisorPresent matrix (the blast-radius pin).
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateAutonomousBookingLane,
  autonomousLaneStamp,
  autonomousLaneEvaluationFor,
  AUTONOMOUS_BOOKING_THRESHOLD_FLOOR,
  AUTONOMOUS_BOOKING_THRESHOLD_DEFAULT,
  type EvaluateAutonomousLaneInput,
} from '../../src/proposals/autonomous-lane';
import {
  createProposal,
  decideInitialStatus,
  InMemoryProposalRepository,
  LANE_BOOKING_BOOKED_STATUSES,
  laneBookingUndoneByOwner,
  VALID_PROPOSAL_TYPES,
  type ProposalStatus,
  type ProposalType,
  type TrustTier,
} from '../../src/proposals/proposal';
import { LEGACY_AUTO_APPROVE_THRESHOLD } from '../../src/proposals/auto-approve';

// followup-autoapprove-default audit — standing invariant pin. See the doc
// comments on AUTONOMOUS_BOOKING_THRESHOLD_FLOOR (this file's module) and
// LEGACY_AUTO_APPROVE_THRESHOLD (proposals/auto-approve.ts) for the full
// mechanism: ai/voice-turn/create-voice-turn-processor.ts never threads
// supervisorMode/supervisorPresent, so its create_booking proposals always
// fall through decideInitialStatus's GENERIC shouldAutoApprove(confidence,
// LEGACY_AUTO_APPROVE_THRESHOLD) check rather than consulting this lane's own
// dedicated threshold — harmless ONLY while this holds, because eligibility
// already guarantees confidenceScore >= AUTONOMOUS_BOOKING_THRESHOLD_FLOOR.
// If either constant moves independently and breaks this, a lane-eligible
// booking from that caller would silently land in 'draft' instead of
// 'approved' with no other test catching it (both constants are declared and
// tested in their own modules with no shared reference between them).
describe('accidental coupling — AUTONOMOUS_BOOKING_THRESHOLD_FLOOR vs LEGACY_AUTO_APPROVE_THRESHOLD', () => {
  it('the floor is never stricter than the legacy threshold create-voice-turn-processor.ts actually applies', () => {
    expect(AUTONOMOUS_BOOKING_THRESHOLD_FLOOR).toBeGreaterThanOrEqual(
      LEGACY_AUTO_APPROVE_THRESHOLD,
    );
  });
});

const NOW = new Date('2026-07-02T15:00:00Z');

function eligibleInput(): EvaluateAutonomousLaneInput {
  return {
    settings: { enabled: true, threshold: 0.95 },
    ownerPhone: '+15555550100',
    undoChannelAvailable: true,
    slotConflictFree: true,
    proposalType: 'create_booking',
    inboundReceptionistSource: true,
    confidenceScore: 0.97,
    payload: { start: '2026-07-03T14:00:00Z' },
    missingFields: [],
    pendingReferenceCount: 0,
    customerId: 'cust-1',
    holdPlaced: true,
    holdExpiryAt: new Date(NOW.getTime() + 5 * 60_000),
    now: NOW,
    slotWithinBusinessHours: true,
    flags: {},
  };
}

describe('evaluateAutonomousBookingLane — every gate blocks independently', () => {
  it('all gates pass → eligible with the tenant threshold', () => {
    expect(evaluateAutonomousBookingLane(eligibleInput())).toEqual({
      eligible: true,
      threshold: 0.95,
    });
  });

  const cases: Array<[string, Partial<EvaluateAutonomousLaneInput>, string]> = [
    ['platform kill switch (tenant opted in)', { platformDisabled: true }, 'platform_disabled'],
    [
      'platform kill switch checked BEFORE tenant opt-in',
      { platformDisabled: true, settings: { enabled: false } },
      'platform_disabled',
    ],
    ['tenant not opted in', { settings: { enabled: false } }, 'tenant_not_opted_in'],
    ['settings absent', { settings: undefined }, 'tenant_not_opted_in'],
    ['no owner cell on file', { ownerPhone: null }, 'owner_cell_missing'],
    ['blank owner cell', { ownerPhone: '   ' }, 'owner_cell_missing'],
    [
      'owner UNDO SMS cannot be sent (unwired, or the SMS kill switch is off)',
      { undoChannelAvailable: false },
      'undo_channel_unavailable',
    ],
    [
      'owner cell checked BEFORE the UNDO channel',
      { ownerPhone: null, undoChannelAvailable: false },
      'owner_cell_missing',
    ],
    ['caller language without localized booking copy', { callerLanguageSupported: false }, 'language_unsupported'],
    ['the slot-conflict check did not run', { slotConflictFree: false }, 'conflict_check_unavailable'],
    ['the prompt-injection guard flagged the session', { flags: { injection: true } }, 'session_flagged'],
    [
      'tenant opt-in checked BEFORE the owner cell',
      { settings: { enabled: false }, ownerPhone: null },
      'tenant_not_opted_in',
    ],
    [
      'owner memo with no owner cell reports the structural reason, not the cell',
      { inboundReceptionistSource: false, ownerPhone: null },
      'not_inbound_receptionist',
    ],
    [
      'non-booking type with no owner cell reports the structural reason, not the cell',
      { proposalType: 'draft_estimate' as ProposalType, ownerPhone: null },
      'proposal_type_not_eligible',
    ],
    [
      'non-booking type',
      { proposalType: 'draft_estimate' as ProposalType },
      'proposal_type_not_eligible',
    ],
    [
      'money type can never take the lane',
      { proposalType: 'record_payment' as ProposalType },
      'proposal_type_not_eligible',
    ],
    ['owner-memo source', { inboundReceptionistSource: false }, 'not_inbound_receptionist'],
    ['vulnerability flag', { flags: { vulnerability: true } }, 'session_flagged'],
    ['emergency flag', { flags: { emergency: true } }, 'session_flagged'],
    ['negotiation flag', { flags: { negotiation: true } }, 'session_flagged'],
    [
      'low confidence marker',
      { payload: { _meta: { overallConfidence: 'low' } } },
      'confidence_marker_blocks',
    ],
    ['missing fields', { missingFields: ['startTime'] }, 'missing_fields'],
    ['pending references', { pendingReferenceCount: 1 }, 'pending_references'],
    ['no verified customer', { customerId: undefined }, 'no_verified_customer'],
    ['no held slot', { holdPlaced: false }, 'no_held_slot'],
    [
      'expired hold',
      { holdExpiryAt: new Date(NOW.getTime() - 1) },
      'hold_expired',
    ],
    ['missing hold expiry', { holdExpiryAt: undefined }, 'hold_expired'],
    ['outside business hours', { slotWithinBusinessHours: false }, 'outside_business_hours'],
    ['below threshold', { confidenceScore: 0.94 }, 'below_threshold'],
    ['missing confidence', { confidenceScore: undefined }, 'below_threshold'],
  ];

  for (const [name, patch, reason] of cases) {
    it(`${name} → ineligible (${reason})`, () => {
      const result = evaluateAutonomousBookingLane({ ...eligibleInput(), ...patch });
      expect(result).toEqual({ eligible: false, reason });
    });
  }

  it('an UNDO channel or conflict check that is not affirmatively true fails closed', () => {
    for (const patch of [
      { undoChannelAvailable: undefined as unknown as boolean },
      { slotConflictFree: undefined as unknown as boolean },
    ]) {
      expect(evaluateAutonomousBookingLane({ ...eligibleInput(), ...patch }).eligible).toBe(false);
    }
  });

  it('callerLanguageSupported absent (no caller on this surface) does not block', () => {
    expect(evaluateAutonomousBookingLane({ ...eligibleInput(), callerLanguageSupported: undefined })).toEqual({
      eligible: true,
      threshold: 0.95,
    });
  });

  it('platformDisabled absent/false ⇒ byte-identical to today (eligible when every other gate passes)', () => {
    expect(evaluateAutonomousBookingLane({ ...eligibleInput(), platformDisabled: undefined })).toEqual({
      eligible: true,
      threshold: 0.95,
    });
    expect(evaluateAutonomousBookingLane({ ...eligibleInput(), platformDisabled: false })).toEqual({
      eligible: true,
      threshold: 0.95,
    });
  });

  it('threshold floor is enforced in code — a 0.80 setting still judges at 0.90', () => {
    const result = evaluateAutonomousBookingLane({
      ...eligibleInput(),
      settings: { enabled: true, threshold: 0.8 },
      confidenceScore: 0.89,
    });
    expect(result).toEqual({ eligible: false, reason: 'below_threshold' });
    const pass = evaluateAutonomousBookingLane({
      ...eligibleInput(),
      settings: { enabled: true, threshold: 0.8 },
      confidenceScore: 0.91,
    });
    expect(pass).toEqual({ eligible: true, threshold: AUTONOMOUS_BOOKING_THRESHOLD_FLOOR });
  });

  it('unset threshold defaults to 0.95', () => {
    const result = evaluateAutonomousBookingLane({
      ...eligibleInput(),
      settings: { enabled: true },
      confidenceScore: 0.94,
    });
    expect(result).toEqual({ eligible: false, reason: 'below_threshold' });
    expect(AUTONOMOUS_BOOKING_THRESHOLD_DEFAULT).toBe(0.95);
  });

  it('stamp round-trips through sourceContext via the typed reader', () => {
    const evaluation = evaluateAutonomousBookingLane(eligibleInput());
    const proposal = { sourceContext: { ...autonomousLaneStamp(evaluation) } };
    expect(autonomousLaneEvaluationFor(proposal)).toEqual(evaluation);
    expect(autonomousLaneEvaluationFor({ sourceContext: {} })).toBeUndefined();
    expect(autonomousLaneEvaluationFor({})).toBeUndefined();
  });
});

describe('decideInitialStatus × autonomous lane', () => {
  const TIERS: Array<TrustTier | undefined> = [
    undefined,
    'autonomous',
    'graduates_fast',
    'graduates_slowly',
    'always_asks',
  ];

  it('BLAST-RADIUS PIN — lane input absent ⇒ byte-identical across the full matrix', () => {
    for (const proposalType of VALID_PROPOSAL_TYPES) {
      for (const sourceTrustTier of TIERS) {
        for (const supervisorPresent of [true, false, undefined]) {
          for (const confidenceScore of [undefined, 0.5, 0.93, 0.99]) {
            const base = {
              proposalType,
              sourceTrustTier,
              confidenceScore,
              supervisorPresent,
            } as Parameters<typeof decideInitialStatus>[0];
            expect(decideInitialStatus({ ...base })).toBe(
              decideInitialStatus({ ...base, autonomousLane: undefined }),
            );
          }
        }
      }
    }
  });

  it('unsupervised + eligible lane + confidence ≥ lane threshold ⇒ approved (booking types)', () => {
    for (const proposalType of ['create_appointment', 'create_booking'] as ProposalType[]) {
      expect(
        decideInitialStatus({
          proposalType,
          sourceTrustTier: 'autonomous',
          confidenceScore: 0.96,
          supervisorPresent: false,
          autonomousLane: { eligible: true, threshold: 0.95 },
        }),
      ).toBe('approved');
    }
  });

  it('unsupervised + eligible lane but confidence below lane threshold ⇒ ready_for_review', () => {
    expect(
      decideInitialStatus({
        proposalType: 'create_booking',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.94,
        supervisorPresent: false,
        autonomousLane: { eligible: true, threshold: 0.95 },
      }),
    ).toBe('ready_for_review');
  });

  it('lane can never approve money/comms/irreversible — the branch is unreachable for them', () => {
    for (const proposalType of [
      'issue_invoice',
      'record_payment',
      'apply_late_fee',
      'send_invoice',
      'send_estimate',
      'notify_delay',
      'cancel_appointment',
      'emergency_dispatch',
    ] as ProposalType[]) {
      expect(
        decideInitialStatus({
          proposalType,
          sourceTrustTier: 'autonomous',
          confidenceScore: 0.99,
          supervisorPresent: false,
          // Hostile input: even a forged eligible-lane object must not approve.
          autonomousLane: { eligible: true, threshold: 0.9 },
        }),
      ).toBe('draft');
    }
  });

  it('low `_meta` confidence marker blocks the lane (checked before threshold resolution)', () => {
    expect(
      decideInitialStatus({
        proposalType: 'create_booking',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.99,
        supervisorPresent: false,
        payload: { _meta: { overallConfidence: 'low' } },
        autonomousLane: { eligible: true, threshold: 0.95 },
      }),
    ).toBe('draft');
  });

  it('missing fields force draft even with an eligible lane', () => {
    expect(
      decideInitialStatus({
        proposalType: 'create_booking',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.99,
        supervisorPresent: false,
        missingFields: ['startTime'],
        autonomousLane: { eligible: true, threshold: 0.95 },
      }),
    ).toBe('draft');
  });

  it('supervised tenant ignores the lane input — the normal mode threshold applies', () => {
    // Supervisor present resolves a non-null threshold, so the lane branch
    // is never reached; a 0.93 booking approves at the default 0.90, lane
    // or no lane.
    const withLane = decideInitialStatus({
      proposalType: 'create_booking',
      sourceTrustTier: 'autonomous',
      confidenceScore: 0.93,
      supervisorPresent: true,
      autonomousLane: { eligible: true, threshold: 0.95 },
    });
    const withoutLane = decideInitialStatus({
      proposalType: 'create_booking',
      sourceTrustTier: 'autonomous',
      confidenceScore: 0.93,
      supervisorPresent: true,
    });
    expect(withLane).toBe(withoutLane);
  });
});

describe('digest auto-booked rows (InMemoryProposalRepository mirror of the Postgres query)', () => {
  // Value: protects=the in-memory mirror counts exactly what Postgres counts: machine-approved lane bookings in a booked status;
  //   fails_when=the mirror drifts from the Postgres status list or approved_at = created_at predicate;
  //   why_new=the mirror had no test (digest tests mock the repo); seam=none; no_claim=the SQL itself (digest-reflection integration)
  it('returns machine-approved lane bookings in every booked status, never held or human-approved ones', async () => {
    const repo = new InMemoryProposalRepository();
    const created = new Date('2026-07-10T15:00:00.000Z');
    const lane = { autonomousLaneEvaluation: { eligible: true, threshold: 0.95 } };
    const make = (status: ProposalStatus, approvedAt?: Date) =>
      repo.create({
        ...createProposal({
          tenantId: 't-1',
          proposalType: 'create_booking',
          payload: {},
          summary: 'Booking',
          createdBy: 'voice',
          sourceContext: lane,
        }),
        status,
        createdAt: created,
        updatedAt: created,
        approvedAt,
      });
    const booked = await Promise.all(
      LANE_BOOKING_BOOKED_STATUSES.map((status) => make(status, created)),
    );
    await make('ready_for_review');
    await make('executed', new Date(created.getTime() + 3_600_000));

    const rows = await repo.findAutonomousLaneApprovedForDay(
      't-1',
      new Date('2026-07-10T00:00:00.000Z'),
      new Date('2026-07-11T00:00:00.000Z'),
    );
    expect(rows.map((r) => r.id).sort()).toEqual(booked.map((p) => p.id).sort());
    expect(LANE_BOOKING_BOOKED_STATUSES).toContain('execution_failed');
  });

  it('counts an owner UNDO before execution (status) or after it (ownerUndo stamp), not a bare cancellation', () => {
    expect(laneBookingUndoneByOwner({ status: 'undone', sourceContext: {} })).toBe(true);
    expect(
      laneBookingUndoneByOwner({
        status: 'executed',
        sourceContext: { ownerUndo: { at: '2026-07-10T16:00:00.000Z', phase: 'post_execution_compensated' } },
      }),
    ).toBe(true);
    expect(laneBookingUndoneByOwner({ status: 'executed', sourceContext: {} })).toBe(false);
  });
});
