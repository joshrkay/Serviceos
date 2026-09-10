/**
 * Chat-surface scoring for the in-app 50-case register (pure).
 *
 * The voice scorer next door reads FSM evidence — states, side effects, spoken
 * lines. The chat surfaces (`POST /api/assistant/chat`, typed and mic) have
 * none of that: what they produce is an HTTP reply and a proposal row. These
 * tests pin the translation, and in particular the two halves that are easy to
 * get quietly wrong:
 *
 *   1. what chat DELIBERATELY ignores. `allowedStates` / `stateAfterTurn` /
 *      `requireSideEffects` name `InAppVoiceAdapter` concepts with no HTTP
 *      counterpart, and scoring them would manufacture failures the product
 *      does not have.
 *   2. what chat must NOT be let off. Payload, entity ids, gates, proposal
 *      count and the operator-visible copy are scored exactly as hard as on
 *      voice — the whole point is that typing and speaking both work.
 */
import { describe, it, expect } from 'vitest';

import type { CaseExpect, RegisterCase } from '../../../../src/ai/voice-quality/inapp-50/register';
import {
  chatAnswered,
  deriveChatStage,
  evaluateChatExpectations,
  isChatIntentCaptureOnly,
  scoreChatCase,
  type ChatCaseEvidence,
  type ChatTurnEvidence,
  type ProposalEvidence,
} from '../../../../src/ai/voice-quality/inapp-50/score';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const FIXTURES = { 'customer.garcia': CUSTOMER_ID };

function turn(over: Partial<ChatTurnEvidence> = {}): ChatTurnEvidence {
  return {
    index: 1,
    text: 'Book Garcia for Tuesday at 2 pm',
    inputMode: 'text',
    httpStatus: 200,
    content: 'Appointment — Tuesday at 2:00 PM. Review and approve to proceed.',
    taskType: 'assistant.create_appointment',
    proposalIds: [],
    ...over,
  };
}

function proposal(over: Partial<ProposalEvidence> = {}): ProposalEvidence {
  return {
    id: 'p1',
    proposalType: 'create_appointment',
    status: 'ready_for_review',
    missingFields: [],
    payload: { customerId: CUSTOMER_ID, scheduledStart: '2026-09-15T21:00:00.000Z' },
    ...over,
  };
}

function evidence(over: Partial<ChatCaseEvidence> = {}): ChatCaseEvidence {
  const turns = over.turns ?? [turn()];
  return {
    turns,
    proposals: over.proposals ?? [],
    replies: over.replies ?? turns.map((t) => t.content),
    auditEvents: over.auditEvents ?? [],
    clarificationTurnSent: over.clarificationTurnSent ?? false,
    ...(over.error !== undefined ? { error: over.error } : {}),
    ...(over.timedOut !== undefined ? { timedOut: over.timedOut } : {}),
  };
}

function registerCase(over: Partial<RegisterCase> = {}): RegisterCase {
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
    fixtureRefs: [],
    expect: { outcome: 'proposal', proposalType: 'create_appointment' },
    ...over,
  } as RegisterCase;
}

const proposalExpect: CaseExpect = {
  outcome: 'proposal',
  proposalType: 'create_appointment',
  payloadContains: { customerId: 'customer.garcia' },
};

describe('deriveChatStage', () => {
  it('is none when every turn failed', () => {
    expect(deriveChatStage(evidence({ turns: [turn({ httpStatus: 500 })] }))).toBe('none');
  });

  it('is intent_detected when a branch claimed the turn but nothing landed', () => {
    expect(deriveChatStage(evidence())).toBe('intent_detected');
  });

  it('is proposal_created once a row exists', () => {
    expect(deriveChatStage(evidence({ proposals: [proposal()] }))).toBe('proposal_created');
  });

  it('is committed for an auto-approved row', () => {
    expect(
      deriveChatStage(evidence({ proposals: [proposal({ status: 'approved' })] })),
    ).toBe('committed');
  });

  it('is answered for a lookup reply', () => {
    expect(
      deriveChatStage(
        evidence({ turns: [turn({ taskType: 'assistant.lookup.lookup_balance' })] }),
      ),
    ).toBe('answered');
  });

  it('is answered for an honest not-found — the correct outcome, not "nothing landed"', () => {
    const ev = evidence({
      turns: [
        turn({
          taskType: 'assistant.cancel_appointment.not_found',
          content: "I couldn't find a matching appointment for Patel.",
        }),
      ],
    });
    expect(chatAnswered(ev)).toBe(true);
    expect(deriveChatStage(ev)).toBe('answered');
    expect(isChatIntentCaptureOnly('answered', ev)).toBe(false);
  });

  it('is guarded when the route refused deterministically and drafted nothing', () => {
    expect(
      deriveChatStage(
        evidence({ turns: [turn({ taskType: 'assistant.unhandled.emergency_dispatch' })] }),
      ),
    ).toBe('guarded');
  });

  it('is clarification_asked when the reply asked which one and nothing was drafted', () => {
    expect(
      deriveChatStage(
        evidence({
          turns: [turn({ content: 'I found more than one Smith — which one did you mean?' })],
        }),
      ),
    ).toBe('clarification_asked');
  });
});

describe('evaluateChatExpectations', () => {
  it('passes a booking whose row carries the resolved fixture id', () => {
    expect(
      evaluateChatExpectations(proposalExpect, evidence({ proposals: [proposal()] }), FIXTURES),
    ).toEqual([]);
  });

  it('resolves a fixture key before comparing, and reports the mismatch otherwise', () => {
    const failures = evaluateChatExpectations(
      proposalExpect,
      evidence({ proposals: [proposal({ payload: { customerId: 'someone-else' } })] }),
      FIXTURES,
    );
    expect(failures.join(' ')).toContain('payload.customerId');
  });

  it('reports a gate the case required and the row does not carry', () => {
    const failures = evaluateChatExpectations(
      { ...proposalExpect, missingFieldsContains: ['customerId'] },
      evidence({ proposals: [proposal()] }),
      FIXTURES,
    );
    expect(failures).toContain("missingFields does not gate on 'customerId'");
  });

  it('counts every persisted row for proposalCount — a double-submit cannot hide', () => {
    const failures = evaluateChatExpectations(
      { ...proposalExpect, proposalCount: 1 },
      evidence({ proposals: [proposal(), proposal({ id: 'p2' })] }),
      FIXTURES,
    );
    expect(failures).toContain('proposalCount 2 ≠ expected 1');
  });

  it('IGNORES the FSM-only expectations chat has no counterpart for', () => {
    const failures = evaluateChatExpectations(
      {
        ...proposalExpect,
        allowedStates: ['intent_capture'],
        stateAfterTurn: { '1': 'intent_confirm' },
        requireSideEffects: ['notify_oncall'],
        forbidSideEffects: ['tts_play'],
      },
      evidence({ proposals: [proposal()] }),
      FIXTURES,
    );
    expect(failures).toEqual([]);
  });

  it('scores a lookup answer on the reply text, and refuses a proposal in its place', () => {
    const answered = evidence({
      turns: [
        turn({
          taskType: 'assistant.lookup.lookup_balance',
          content: 'Khan Household owes $450.00 across one open invoice.',
        }),
      ],
    });
    expect(
      evaluateChatExpectations(
        { outcome: 'lookup_answer', proposalCount: 0, spokenMatches: 'owes|open invoice' },
        answered,
        FIXTURES,
      ),
    ).toEqual([]);

    const drafted = evidence({
      turns: [turn({ taskType: 'assistant.draft_invoice' })],
      proposals: [proposal({ proposalType: 'draft_invoice' })],
    });
    expect(
      evaluateChatExpectations({ outcome: 'lookup_answer' }, drafted, FIXTURES).join(' '),
    ).toContain('replaced the read-only answer');
  });

  it('accepts an emergency_dispatch DRAFT for an escalation — chat pages nobody', () => {
    const ev = evidence({
      turns: [turn({ taskType: 'assistant.emergency_dispatch' })],
      proposals: [proposal({ proposalType: 'emergency_dispatch' })],
    });
    expect(
      evaluateChatExpectations(
        { outcome: 'escalation', spokenMatches: 'emergency|on-call' },
        ev,
        FIXTURES,
      ),
    ).toEqual([]);
  });

  it('reports an emergency that produced neither a draft nor emergency copy', () => {
    const ev = evidence({
      turns: [turn({ taskType: 'assistant.general', content: 'Tell me more.' })],
    });
    expect(
      evaluateChatExpectations(
        { outcome: 'escalation', spokenMatches: 'emergency|on-call' },
        ev,
        FIXTURES,
      ).join(' '),
    ).toContain('emergency');
  });

  it('requires the audited act for a direct_act, and forbids a proposal replacing it', () => {
    const fired = evidence({
      turns: [
        turn({ taskType: 'assistant.en_route', content: "You're marked en route — Khan notified." }),
      ],
      auditEvents: ['appointment.en_route_triggered'],
    });
    expect(
      evaluateChatExpectations(
        {
          outcome: 'direct_act',
          proposalCount: 0,
          spokenMatches: 'marked en route|notified',
          requireAuditEvents: ['appointment.en_route_triggered'],
        },
        fired,
        FIXTURES,
      ),
    ).toEqual([]);

    const refused = evidence({
      turns: [turn({ taskType: 'assistant.en_route', content: 'nothing was sent' })],
    });
    expect(
      evaluateChatExpectations(
        {
          outcome: 'direct_act',
          spokenMatches: 'marked en route',
          requireAuditEvents: ['appointment.en_route_triggered'],
        },
        refused,
        FIXTURES,
      ),
    ).toContain("required audit event 'appointment.en_route_triggered' was never written");
  });

  it('a guard must write nothing at all', () => {
    expect(
      evaluateChatExpectations(
        { outcome: 'guard', proposalCount: 0, spokenMatches: 'anything waiting' },
        evidence({
          turns: [
            turn({
              taskType: 'assistant.confirm_nothing_pending',
              content: "I don't have anything waiting on a yes from you just yet",
            }),
          ],
        }),
        FIXTURES,
      ),
    ).toEqual([]);
    expect(
      evaluateChatExpectations(
        { outcome: 'guard', proposalCount: 0 },
        evidence({ proposals: [proposal()] }),
        FIXTURES,
      ).join(' '),
    ).toContain('minted on a guard turn');
  });
});

describe('scoreChatCase', () => {
  it('FAILs an approve-to-fail card whatever else the case achieved', () => {
    const score = scoreChatCase(
      registerCase(),
      proposalExpect,
      evidence({
        proposals: [
          proposal({ contractViolation: "voice-minted 'create_appointment' failed …" }),
        ],
      }),
      FIXTURES,
    );
    expect(score.verdict).toBe('FAIL');
    expect(score.rootCause?.category).toBe('proposal_generation');
  });

  it('FAILs a 5xx as infra, naming the turn', () => {
    const score = scoreChatCase(
      registerCase(),
      proposalExpect,
      evidence({ turns: [turn({ httpStatus: 500 })] }),
      FIXTURES,
    );
    expect(score.verdict).toBe('FAIL');
    expect(score.rootCause?.category).toBe('infra');
  });

  it('PASSes a clean booking', () => {
    const score = scoreChatCase(
      registerCase(),
      proposalExpect,
      evidence({ proposals: [proposal()] }),
      FIXTURES,
    );
    expect(score.verdict).toBe('PASS');
    expect(score.rootCause).toBeNull();
  });

  it('DEGRADES when the turn fell through to the generic reply', () => {
    const score = scoreChatCase(
      registerCase(),
      proposalExpect,
      evidence({
        turns: [turn({ taskType: 'assistant.general', content: 'Tell me a bit more.' })],
      }),
      FIXTURES,
    );
    expect(score.verdict).toBe('DEGRADED');
    expect(score.rootCause?.category).toBe('intent');
  });

  it('DEGRADES on a dead voice_clarification card in place of the booking', () => {
    const score = scoreChatCase(
      registerCase(),
      proposalExpect,
      evidence({ proposals: [proposal({ proposalType: 'voice_clarification', payload: {} })] }),
      FIXTURES,
    );
    expect(score.verdict).toBe('DEGRADED');
    expect(score.rootCause?.category).toBe('proposal_generation');
  });

  it('is PARTIAL — not DEGRADED — when the right path ran but lost a slot', () => {
    const score = scoreChatCase(
      registerCase(),
      proposalExpect,
      evidence({ proposals: [proposal({ payload: { scheduledStart: 'x' } })] }),
      FIXTURES,
    );
    expect(score.verdict).toBe('PARTIAL');
    expect(score.rootCause?.category).toBe('slot_capture');
  });
});
