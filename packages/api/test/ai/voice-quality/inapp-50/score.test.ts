/**
 * Unit tests for the in-app 50 scoring rules.
 *
 * These run against SYNTHETIC evidence — no adapter, no repos — because the
 * scoring module is where the plan's stage / verdict / root-cause tables are
 * encoded, and a mis-encoded table would silently redefine what "50/50"
 * means. Every verdict and every root-cause category is covered.
 */
import { describe, it, expect } from 'vitest';

import {
  deriveStage,
  evaluateExpectations,
  isIntentCaptureOnly,
  isoWeekdayInZone,
  scoreCase,
  type CaseEvidence,
  type ProposalEvidence,
  type TurnEvidence,
} from '../../../../src/ai/voice-quality/inapp-50/score';
import type { RegisterCase } from '../../../../src/ai/voice-quality/inapp-50/register';

const GARCIA = '11111111-1111-4111-8111-111111111111';
const APPOINTMENT = '22222222-2222-4222-8222-222222222222';
const FIXTURE_IDS = { 'customer.garcia': GARCIA, 'appointment.garcia-tuesday': APPOINTMENT };

function turn(overrides: Partial<TurnEvidence> = {}): TurnEvidence {
  return {
    index: 1,
    text: 'Book Garcia for Tuesday at 2 pm',
    stateBefore: 'intent_capture',
    stateAfter: 'intent_capture',
    sideEffectTypes: [],
    auditEventTypes: [],
    proposalIds: [],
    busEventTypes: [],
    ...overrides,
  };
}

function proposal(overrides: Partial<ProposalEvidence> = {}): ProposalEvidence {
  return {
    id: 'p1',
    proposalType: 'create_appointment',
    status: 'ready_for_review',
    missingFields: [],
    payload: { customerId: GARCIA, scheduledStart: '2026-09-15T21:00:00.000Z' },
    ...overrides,
  };
}

function evidence(overrides: Partial<CaseEvidence> = {}): CaseEvidence {
  return {
    turns: [],
    proposals: [],
    spokenLines: [],
    auditEvents: [],
    finalState: 'intent_capture',
    clarificationTurnSent: false,
    ...overrides,
  };
}

function registerCase(overrides: Partial<RegisterCase> = {}): RegisterCase {
  return {
    id: 1,
    key: 'book-01',
    cluster: 'scheduling',
    op: 'create_appointment',
    cat: 'schedule',
    severity: 'critical',
    intent: 'create_appointment',
    expectProposal: 'create_appointment',
    utterance: 'Book Garcia for Tuesday at 2 pm',
    llm: [{ intentType: 'create_appointment', confidence: 0.94, extractedEntities: {} }],
    fixtureRefs: ['customer.garcia'],
    expect: {
      outcome: 'proposal',
      proposalType: 'create_appointment',
      payloadContains: { customerId: 'customer.garcia' },
    },
    ...overrides,
  } as RegisterCase;
}

/** The full happy path: classified, resolved, confirmed, queued. */
function committedTurns(): TurnEvidence[] {
  return [
    turn({
      index: 1,
      stateAfter: 'intent_confirm',
      auditEventTypes: [
        'agent.calling.intent_capture.intent_classified',
        'agent.calling.entity_resolution.entity_resolved',
      ],
      busEventTypes: ['intent_classified'],
      classifiedIntent: 'create_appointment',
      classifiedConfidence: 0.94,
      sideEffectTypes: ['audit_log', 'tts_play'],
    }),
    turn({
      index: 2,
      text: 'yes',
      stateBefore: 'intent_confirm',
      stateAfter: 'closing',
      auditEventTypes: [
        'agent.calling.intent_confirm.confirmed',
        'agent.calling.proposal_draft.proposal_queued',
      ],
      proposalIds: ['p1'],
      sideEffectTypes: ['audit_log', 'create_proposal', 'tts_play'],
    }),
  ];
}

describe('deriveStage', () => {
  it('returns none when nothing ran or every turn threw', () => {
    expect(deriveStage([], [])).toBe('none');
    expect(deriveStage([turn({ error: 'boom' })], [])).toBe('none');
  });

  it('returns intent_detected for a classified turn that went nowhere', () => {
    expect(
      deriveStage(
        [
          turn({
            auditEventTypes: ['agent.calling.intent_capture.intent_classified'],
            busEventTypes: ['intent_classified'],
            classifiedConfidence: 0.94,
          }),
        ],
        [],
      ),
    ).toBe('intent_detected');
  });

  it('ignores a bus classification below tau_int', () => {
    expect(
      deriveStage([turn({ busEventTypes: ['intent_classified'], classifiedConfidence: 0.1 })], []),
    ).toBe('none');
  });

  it('returns entities_resolved, clarification_asked and confirmation_asked in ladder order', () => {
    expect(
      deriveStage(
        [turn({ auditEventTypes: ['agent.calling.entity_resolution.entity_resolved'] })],
        [],
      ),
    ).toBe('entities_resolved');
    expect(
      deriveStage(
        [turn({ auditEventTypes: ['agent.calling.entity_resolution.entity_ambiguous'] })],
        [],
      ),
    ).toBe('clarification_asked');
    expect(deriveStage([turn({ stateAfter: 'intent_confirm' })], [])).toBe('confirmation_asked');
  });

  it('returns proposal_created when a proposal exists but nothing queued it', () => {
    expect(deriveStage([turn({ proposalIds: ['p1'] })], [proposal()])).toBe('proposal_created');
  });

  it('returns committed for a queued proposal', () => {
    expect(deriveStage(committedTurns(), [proposal()])).toBe('committed');
  });

  it('returns answered for a lookup that spoke without touching the FSM', () => {
    const stage = deriveStage(
      [
        turn({
          sideEffectTypes: ['tts_play'],
          classifiedIntent: 'lookup_balance',
          classifiedConfidence: 0.94,
          busEventTypes: ['intent_classified', 'lookup_executed'],
        }),
      ],
      [],
    );
    expect(stage).toBe('answered');
  });

  it('returns answered for an honest operator not-found', () => {
    expect(
      deriveStage(
        [
          turn({
            auditEventTypes: [
              'agent.calling.intent_capture.intent_classified',
              'agent.calling.entity_resolution.entity_not_found_operator',
            ],
            classifiedIntent: 'cancel_appointment',
            classifiedConfidence: 0.93,
            sideEffectTypes: ['audit_log', 'tts_play'],
          }),
        ],
        [],
      ),
    ).toBe('answered');
  });

  it('returns escalated when on-call was paged, even past a readback', () => {
    expect(
      deriveStage([turn({ stateAfter: 'escalating', sideEffectTypes: ['notify_oncall'] })], []),
    ).toBe('escalated');
  });

  it('returns guarded for a confirm with nothing pending', () => {
    expect(
      deriveStage([turn({ auditEventTypes: ['agent.calling.intent_capture.confirm_without_pending'] })], []),
    ).toBe('guarded');
  });
});

describe('isIntentCaptureOnly', () => {
  it('is true when the intent was understood and nothing was produced', () => {
    const ev = evidence({
      turns: [
        turn({
          auditEventTypes: ['agent.calling.intent_capture.intent_classified'],
          classifiedConfidence: 0.9,
        }),
      ],
    });
    expect(isIntentCaptureOnly(deriveStage(ev.turns, ev.proposals), ev)).toBe(true);
  });

  it('is false for an honest operator not-found (gate rule 2 must not trip)', () => {
    const ev = evidence({
      turns: [
        turn({
          auditEventTypes: [
            'agent.calling.intent_capture.intent_classified',
            'agent.calling.entity_resolution.entity_not_found_operator',
          ],
          classifiedConfidence: 0.93,
          sideEffectTypes: ['audit_log', 'tts_play'],
        }),
      ],
    });
    expect(isIntentCaptureOnly(deriveStage(ev.turns, ev.proposals), ev)).toBe(false);
  });

  it('is false once a proposal exists', () => {
    const ev = evidence({ turns: committedTurns(), proposals: [proposal()] });
    expect(isIntentCaptureOnly(deriveStage(ev.turns, ev.proposals), ev)).toBe(false);
  });
});

describe('isoWeekdayInZone', () => {
  it('reads the tenant-local weekday, not UTC', () => {
    // 2026-09-15T21:00Z is Tuesday 14:00 in Phoenix (UTC-7).
    expect(isoWeekdayInZone('2026-09-15T21:00:00.000Z', 'America/Phoenix')).toBe(2);
    // 2026-09-16T02:00Z is still Tuesday 19:00 in Phoenix, Wednesday in UTC.
    expect(isoWeekdayInZone('2026-09-16T02:00:00.000Z', 'America/Phoenix')).toBe(2);
  });

  it('returns undefined for an unresolved value', () => {
    expect(isoWeekdayInZone(undefined, 'America/Phoenix')).toBeUndefined();
  });
});

describe('evaluateExpectations', () => {
  it('resolves fixture keys through fixtureIds and literals as-is', () => {
    const ev = evidence({ turns: committedTurns(), proposals: [proposal()] });
    expect(
      evaluateExpectations(
        { outcome: 'proposal', proposalType: 'create_appointment', payloadContains: { customerId: 'customer.garcia' } },
        ev,
        FIXTURE_IDS,
      ),
    ).toEqual([]);
    expect(
      evaluateExpectations(
        { outcome: 'proposal', proposalType: 'create_appointment', payloadContains: { customerName: 'Elena Ruiz' } },
        ev,
        FIXTURE_IDS,
      ),
    ).toEqual(['payload.customerName is absent']);
  });

  it('checks scheduledStartWeekday in the tenant zone', () => {
    const ev = evidence({ turns: committedTurns(), proposals: [proposal()] });
    expect(
      evaluateExpectations({ outcome: 'proposal', scheduledStartWeekday: 2 }, ev, FIXTURE_IDS, {
        timezone: 'America/Phoenix',
      }),
    ).toEqual([]);
    expect(
      evaluateExpectations({ outcome: 'proposal', scheduledStartWeekday: 4 }, ev, FIXTURE_IDS, {
        timezone: 'America/Phoenix',
      }),
    ).toEqual(['scheduledStart weekday 2 ≠ expected 4 (America/Phoenix)']);
  });

  it('matches spokenMatches against the LAST line and forbidSpoken against every line', () => {
    const ev = evidence({ spokenLines: ['let me look', 'Garcia is booked for Tuesday'] });
    expect(evaluateExpectations({ outcome: 'lookup_answer', spokenMatches: 'garcia' }, ev, {}))
      .toContain('no lookup answer was spoken');
    expect(
      evaluateExpectations({ outcome: 'lookup_answer', spokenMatches: 'let me look' }, ev, {}),
    ).toContainEqual(expect.stringContaining('spoken line did not match'));
    expect(
      evaluateExpectations({ outcome: 'lookup_answer', forbidSpoken: 'let me look' }, ev, {}),
    ).toContainEqual(expect.stringContaining('forbidden'));
  });

  it('enforces proposalCount, allowedStates, side effects and stateAfterTurn', () => {
    const ev = evidence({
      turns: [turn({ index: 1, stateAfter: 'escalating', sideEffectTypes: ['notify_oncall'] })],
      finalState: 'escalating',
    });
    const failures = evaluateExpectations(
      {
        outcome: 'escalation',
        proposalCount: 1,
        allowedStates: ['intent_capture'],
        forbidSideEffects: ['notify_oncall'],
        stateAfterTurn: { '1': 'closing' },
      },
      ev,
      {},
    );
    expect(failures).toEqual([
      'proposalCount 0 ≠ expected 1',
      "forbidden side effect 'notify_oncall' fired",
      "final state 'escalating' ∉ [intent_capture]",
      "state after turn 1 = 'escalating' ≠ 'closing'",
    ]);
  });

  it('finds requireAuditEvents in the repo stream as well as the side-effect stream', () => {
    const sideEffectOnly = evidence({
      turns: [turn({ auditEventTypes: ['agent.calling.en_route_executed'] })],
    });
    expect(
      evaluateExpectations(
        { outcome: 'direct_act', requireAuditEvents: ['agent.calling.en_route_executed'] },
        sideEffectOnly,
        {},
      ),
    ).toEqual([]);

    // The act audits through the REPO, not as an FSM side effect.
    const repoOnly = evidence({
      turns: [turn({ sideEffectTypes: ['tts_play'] })],
      auditEvents: ['appointment.en_route_triggered'],
    });
    expect(
      evaluateExpectations(
        { outcome: 'direct_act', requireAuditEvents: ['appointment.en_route_triggered'] },
        repoOnly,
        {},
      ),
    ).toEqual([]);

    expect(
      evaluateExpectations(
        { outcome: 'direct_act', requireAuditEvents: ['appointment.en_route_triggered'] },
        sideEffectOnly,
        {},
      ),
    ).toEqual(["required audit event 'appointment.en_route_triggered' was never written"]);
  });

  it('requires a disambiguation follow-up when the case asks for one', () => {
    const ev = evidence({ turns: committedTurns(), proposals: [proposal()] });
    expect(
      evaluateExpectations({ outcome: 'proposal', requireClarificationTurn: true }, ev, {}),
    ).toEqual(['no disambiguation follow-up was asked for (and answered)']);
  });
});

describe('scoreCase', () => {
  it('PASSes the full happy path', () => {
    const score = scoreCase(
      registerCase(),
      evidence({ turns: committedTurns(), proposals: [proposal()] }),
      FIXTURE_IDS,
    );
    expect(score.verdict).toBe('PASS');
    expect(score.stage).toBe('committed');
    expect(score.rootCause).toBeNull();
  });

  it('FAILs an approve-to-fail proposal regardless of the rest', () => {
    const score = scoreCase(
      registerCase(),
      evidence({
        turns: committedTurns(),
        proposals: [proposal({ contractViolation: 'missing estimateId with no gate' })],
      }),
      FIXTURE_IDS,
    );
    expect(score.verdict).toBe('FAIL');
    expect(score.rootCause).toEqual({
      category: 'proposal_generation',
      detail: 'missing estimateId with no gate',
    });
  });

  it('FAILs a thrown turn with an infra root cause and stage none', () => {
    const score = scoreCase(
      registerCase(),
      evidence({ turns: [turn({ error: 'voice session not found' })] }),
      FIXTURE_IDS,
    );
    expect(score.verdict).toBe('FAIL');
    expect(score.stage).toBe('none');
    expect(score.rootCause?.category).toBe('infra');
  });

  it('FAILs a payload-contract audit', () => {
    const turns = committedTurns();
    turns[1].auditEventTypes.push('agent.calling.proposal_draft.voice.payload_contract_failed');
    const score = scoreCase(registerCase(), evidence({ turns, proposals: [] }), FIXTURE_IDS);
    expect(score.verdict).toBe('FAIL');
    expect(score.rootCause?.category).toBe('proposal_generation');
  });

  it('is PARTIAL with a slot_capture cause when a payload key never resolved', () => {
    const score = scoreCase(
      registerCase({
        expect: {
          outcome: 'proposal',
          proposalType: 'create_appointment',
          payloadContains: { appointmentId: 'appointment.garcia-tuesday' },
        },
      }),
      evidence({ turns: committedTurns(), proposals: [proposal()] }),
      FIXTURE_IDS,
    );
    expect(score.verdict).toBe('PARTIAL');
    expect(score.stage).toBe('committed');
    expect(score.rootCause?.category).toBe('slot_capture');
    expect(score.rootCause?.detail).toContain('payload.appointmentId is absent');
  });

  it('is PARTIAL when the case ends intent_capture_only', () => {
    const turns = [
      turn({
        auditEventTypes: ['agent.calling.intent_capture.intent_classified'],
        classifiedIntent: 'create_appointment',
        classifiedConfidence: 0.94,
        busEventTypes: ['intent_classified'],
        stateAfter: 'intent_confirm',
      }),
    ];
    const ev = evidence({ turns });
    const score = scoreCase(registerCase(), ev, FIXTURE_IDS);
    expect(score.verdict).toBe('PARTIAL');
    expect(score.stage).toBe('confirmation_asked');
    expect(isIntentCaptureOnly(score.stage, ev)).toBe(true);
  });

  it('is DEGRADED with a proposal_generation cause when voice_clarification replaced a mapped intent', () => {
    const score = scoreCase(
      registerCase(),
      evidence({
        turns: committedTurns(),
        proposals: [proposal({ proposalType: 'voice_clarification', payload: {} })],
      }),
      FIXTURE_IDS,
    );
    expect(score.verdict).toBe('DEGRADED');
    expect(score.rootCause?.category).toBe('proposal_generation');
  });

  it('is DEGRADED with a fallback cause when a lookup got a dead clarification card', () => {
    const score = scoreCase(
      registerCase({
        intent: 'lookup_balance',
        expectProposal: null,
        expect: { outcome: 'lookup_answer', proposalCount: 0 },
      }),
      evidence({
        turns: [
          turn({
            auditEventTypes: ['agent.calling.intent_capture.intent_classified'],
            classifiedIntent: 'lookup_balance',
            classifiedConfidence: 0.94,
          }),
        ],
        proposals: [proposal({ proposalType: 'voice_clarification', payload: {} })],
      }),
      FIXTURE_IDS,
    );
    expect(score.verdict).toBe('DEGRADED');
    expect(score.rootCause?.category).toBe('fallback');
  });

  it('is DEGRADED with an intent cause when nothing classified above tau_int', () => {
    const score = scoreCase(
      registerCase(),
      evidence({
        turns: [
          turn({
            auditEventTypes: ['agent.calling.intent_capture.reprompt'],
            classifiedIntent: 'unknown',
            classifiedConfidence: 0.1,
          }),
        ],
      }),
      FIXTURE_IDS,
    );
    expect(score.verdict).toBe('DEGRADED');
    expect(score.rootCause?.category).toBe('intent');
  });

  it('is DEGRADED with a fallback cause when an operator not-found paged on-call', () => {
    const score = scoreCase(
      registerCase({
        key: 'cancel-02',
        intent: 'cancel_appointment',
        expectProposal: null,
        fixtureRefs: [],
        expect: {
          outcome: 'not_found',
          proposalCount: 0,
          forbidSideEffects: ['notify_oncall'],
          allowedStates: ['intent_capture', 'closing'],
        },
      }),
      evidence({
        turns: [
          turn({
            auditEventTypes: ['agent.calling.intent_capture.intent_classified'],
            classifiedIntent: 'cancel_appointment',
            classifiedConfidence: 0.93,
            sideEffectTypes: ['notify_oncall'],
            stateAfter: 'escalating',
          }),
        ],
        finalState: 'escalating',
      }),
      FIXTURE_IDS,
    );
    expect(score.verdict).toBe('DEGRADED');
    expect(score.stage).toBe('escalated');
    expect(score.rootCause?.category).toBe('fallback');
  });

  it('is DEGRADED with a fallback cause when an entitled lookup heard the handoff line', () => {
    const score = scoreCase(
      registerCase({
        intent: 'lookup_invoices',
        expectProposal: null,
        expect: { outcome: 'lookup_answer', spokenMatches: 'INV-' },
      }),
      evidence({
        turns: [
          turn({
            sideEffectTypes: ['tts_play'],
            classifiedIntent: 'lookup_invoices',
            classifiedConfidence: 0.93,
            busEventTypes: ['lookup_executed'],
          }),
        ],
        spokenLines: ["I'm having trouble pulling that up — let me get a person to help."],
      }),
      FIXTURE_IDS,
    );
    expect(score.verdict).toBe('DEGRADED');
    expect(score.rootCause?.category).toBe('fallback');
  });
});
