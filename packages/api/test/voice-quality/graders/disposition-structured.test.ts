/**
 * VQ-021 — Disposition-structured grader tests.
 *
 * Exercises criteria 9 (intent), 11 (escalation), and the hard-slot
 * subset of criterion 10 (proposal payload deep-diff). Soft slots and
 * criterion 12 are owned by the LLM-judge in VQ-022 and are explicitly
 * NOT failed here.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  gradeDispositionStructured,
  loadGoldenForScript,
} from '../../../src/ai/voice-quality/graders/disposition-structured';
import type { Observation } from '../../../src/ai/voice-quality/observation';
import type { VoiceQualityScript } from '../../../src/ai/voice-quality/schema';
import type { Proposal } from '../../../src/proposals/proposal';
import type { VoiceSessionEvent } from '../../../src/ai/agents/customer-calling/voice-session-store';

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    callId: 'call-1',
    scriptId: 'script-1',
    tenantId: 't-1',
    events: [],
    proposals: [],
    customerCountDelta: 0,
    appointmentCountDelta: 0,
    audit: [],
    totalCostCents: 0,
    totalDurationMs: 0,
    perTurnLatencyMs: [],
    sessionEndedAs: 'completed',
    hangupOccurred: false,
    errors: [],
    ...overrides,
  };
}

function makeScript(overrides: Partial<VoiceQualityScript> = {}): VoiceQualityScript {
  return {
    id: 'script-1',
    bucket: '01-happy-lookups',
    fixtures: { tenant: {}, customers: [] },
    callerId: '+15551234567',
    callerIdBlocked: false,
    turns: [],
    grading: { appliesFloor: [], appliesDisposition: [9, 10, 11] },
    layer2Eligible: false,
    ...overrides,
  };
}

function intentEvent(intentType: string, ts = 1_000): VoiceSessionEvent {
  return {
    type: 'intent_classified',
    intentType,
    confidence: 0.9,
    tokenUsage: { inputTokens: 0, outputTokens: 0, costCents: 0 },
    ts,
  };
}

function escalationEvent(reason = 'caller_request', ts = 2_000): VoiceSessionEvent {
  return { type: 'escalation_triggered', reason, ts };
}

function makeProposal(payload: Record<string, unknown>, type = 'create_appointment'): Proposal {
  return {
    id: 'p-1',
    tenantId: 't-1',
    proposalType: type as Proposal['proposalType'],
    status: 'ready_for_review',
    payload,
    summary: 'test proposal',
    createdBy: 'agent',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe('VQ-021 — gradeDispositionStructured', () => {
  it('VQ-021 — passes when intent + slots + proposal type + escalation all match expected', () => {
    const script = makeScript({
      turns: [
        {
          caller: 'book me an appointment',
          expected: {
            intent: 'book_appointment',
            slots: { customerId: 'c-1', startAt: '2026-05-10T14:00:00Z' },
            proposalType: 'create_appointment',
            escalates: false,
          },
          hangupAfter: false,
        },
      ],
    });
    const obs = makeObservation({
      events: [intentEvent('book_appointment', 1_000)],
      proposals: [makeProposal({ customerId: 'c-1', startAt: '2026-05-10T14:00:00Z' })],
    });

    const result = gradeDispositionStructured(obs, script);

    expect(result.passed).toBe(true);
    expect(result.failedCriteria).toEqual([]);
    expect(result.perTurnDetail[0].intentMatched).toBe(true);
    expect(result.perTurnDetail[0].proposalTypeMatched).toBe(true);
    expect(result.perTurnDetail[0].escalationMatched).toBe(true);
    expect(result.perTurnDetail[0].hardSlotMismatches).toEqual([]);
  });

  it('VQ-021 — fails criterion 9: actualIntent differs from expected.intent', () => {
    const script = makeScript({
      turns: [
        {
          caller: 'book me',
          expected: { intent: 'book_appointment', escalates: false },
          hangupAfter: false,
        },
      ],
    });
    const obs = makeObservation({
      events: [intentEvent('cancel_appointment', 1_000)],
    });

    const result = gradeDispositionStructured(obs, script);

    expect(result.passed).toBe(false);
    expect(result.failedCriteria).toContain(9);
    expect(result.perTurnDetail[0].intentMatched).toBe(false);
    expect(result.perTurnDetail[0].actualIntent).toBe('cancel_appointment');
  });

  it('VQ-021 — fails criterion 10: hard-slot mismatch (e.g., customerId differs)', () => {
    const script = makeScript({
      turns: [
        {
          caller: 'reschedule',
          expected: {
            intent: 'reschedule_appointment',
            slots: { customerId: 'c-1', appointmentId: 'a-1' },
            proposalType: 'reschedule_appointment',
            escalates: false,
          },
          hangupAfter: false,
        },
      ],
    });
    const obs = makeObservation({
      events: [intentEvent('reschedule_appointment', 1_000)],
      proposals: [
        makeProposal(
          { customerId: 'c-WRONG', appointmentId: 'a-1' },
          'reschedule_appointment',
        ),
      ],
    });

    const result = gradeDispositionStructured(obs, script);

    expect(result.passed).toBe(false);
    expect(result.failedCriteria).toContain(10);
    expect(result.perTurnDetail[0].hardSlotMismatches).toContain('customerId');
    expect(result.perTurnDetail[0].hardSlotMismatches).not.toContain('appointmentId');
  });

  // #1331 — the "long string is soft" rule (> 30 chars) ran before the id
  // rule, so a real 36-char UUID id was never graded: once Layer 2 fixtures
  // carry UUIDs, a wrong appointmentId would have passed criterion 10.
  it('#1331 — a UUID record id is a hard slot: the wrong appointment fails criterion 10', () => {
    const script = makeScript({
      turns: [
        {
          caller: 'cancel my Tuesday appointment',
          expected: {
            intent: 'cancel_appointment',
            slots: { appointmentId: '3f1c2a54-9d7e-5b21-8c4f-0a6e9b2d7c11' },
            proposalType: 'cancel_appointment',
          },
          hangupAfter: false,
        },
      ],
    });
    const obs = makeObservation({
      events: [intentEvent('cancel_appointment', 1_000)],
      proposals: [
        makeProposal({ appointmentId: '9a8b7c6d-5e4f-5a3b-9c2d-1e0f9a8b7c6d' }, 'cancel_appointment'),
      ],
    });

    const result = gradeDispositionStructured(obs, script);

    expect(result.failedCriteria).toContain(10);
    expect(result.perTurnDetail[0].hardSlotMismatches).toEqual(['appointmentId']);
  });

  it('VQ-021 — passes criterion 10 with soft-slot differences (notes wording differs)', () => {
    const script = makeScript({
      turns: [
        {
          caller: 'add a note',
          expected: {
            intent: 'add_note',
            slots: {
              customerId: 'c-1',
              notes: 'Caller wants a callback at 3pm tomorrow.',
            },
            proposalType: 'add_note',
            escalates: false,
          },
          hangupAfter: false,
        },
      ],
    });
    const obs = makeObservation({
      events: [intentEvent('add_note', 1_000)],
      proposals: [
        makeProposal(
          {
            customerId: 'c-1',
            notes: 'Wants callback @ 15:00 tomorrow.',
          },
          'add_note',
        ),
      ],
    });

    const result = gradeDispositionStructured(obs, script);

    expect(result.failedCriteria).not.toContain(10);
    expect(result.perTurnDetail[0].hardSlotMismatches).toEqual([]);
  });

  it("VQ-021 — fails criterion 11: agent should have escalated but didn't", () => {
    const script = makeScript({
      turns: [
        {
          caller: 'speak to a human',
          expected: { intent: 'escalate', escalates: true },
          hangupAfter: false,
        },
      ],
    });
    const obs = makeObservation({
      events: [intentEvent('escalate', 1_000)],
    });

    const result = gradeDispositionStructured(obs, script);

    expect(result.passed).toBe(false);
    expect(result.failedCriteria).toContain(11);
    expect(result.perTurnDetail[0].actualEscalated).toBe(false);
    expect(result.perTurnDetail[0].escalationMatched).toBe(false);
  });

  it("VQ-021 — fails criterion 11: agent escalated when it shouldn't have", () => {
    const script = makeScript({
      turns: [
        {
          caller: 'what are your hours',
          expected: { intent: 'business_hours_lookup', escalates: false },
          hangupAfter: false,
        },
      ],
    });
    const obs = makeObservation({
      events: [intentEvent('business_hours_lookup', 1_000), escalationEvent('confused', 1_500)],
    });

    const result = gradeDispositionStructured(obs, script);

    expect(result.passed).toBe(false);
    expect(result.failedCriteria).toContain(11);
    expect(result.perTurnDetail[0].actualEscalated).toBe(true);
    expect(result.perTurnDetail[0].escalationMatched).toBe(false);
  });

  it('VQ-021 — handles missing turns (script has 3 turns, only 2 intent_classified events)', () => {
    const script = makeScript({
      turns: [
        { caller: 'a', expected: { intent: 'i1', escalates: false }, hangupAfter: false },
        { caller: 'b', expected: { intent: 'i2', escalates: false }, hangupAfter: false },
        { caller: 'c', expected: { intent: 'i3', escalates: false }, hangupAfter: false },
      ],
    });
    const obs = makeObservation({
      events: [intentEvent('i1', 1_000), intentEvent('i2', 2_000)],
    });

    const result = gradeDispositionStructured(obs, script);

    expect(result.perTurnDetail).toHaveLength(3);
    expect(result.perTurnDetail[0].intentMatched).toBe(true);
    expect(result.perTurnDetail[1].intentMatched).toBe(true);
    expect(result.perTurnDetail[2].intentMatched).toBe(false);
    expect(result.perTurnDetail[2].actualIntent).toBeUndefined();
    expect(result.failedCriteria).toContain(9);
  });

  it('VQ-021 — handles golden file: loadGoldenForScript reads file when present, returns undefined otherwise', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vq021-'));
    try {
      const goldenDir = path.join(tmp, 'golden');
      fs.mkdirSync(goldenDir, { recursive: true });
      const golden = [{ customerId: 'c-1', notes: 'gold' }];
      fs.writeFileSync(path.join(goldenDir, 'happy.json'), JSON.stringify(golden));

      expect(loadGoldenForScript('happy', tmp)).toEqual(golden);
      expect(loadGoldenForScript('missing', tmp)).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('VQ-021 — slot classification: keys ending in `Id` are hard; `notes` is soft; ISO 8601 date string is hard', () => {
    const script = makeScript({
      turns: [
        {
          caller: 'mixed',
          expected: {
            intent: 'i',
            slots: {
              customerId: 'c-1',
              startAt: '2026-05-10T14:00:00Z',
              notes: 'short note',
            },
            proposalType: 'create_appointment',
            escalates: false,
          },
          hangupAfter: false,
        },
      ],
    });
    const obs = makeObservation({
      events: [intentEvent('i', 1_000)],
      proposals: [
        makeProposal(
          {
            customerId: 'c-OTHER',
            startAt: '2027-01-01T00:00:00Z',
            notes: 'completely different wording',
          },
          'create_appointment',
        ),
      ],
    });

    const result = gradeDispositionStructured(obs, script);

    expect(result.perTurnDetail[0].hardSlotMismatches).toContain('customerId');
    expect(result.perTurnDetail[0].hardSlotMismatches).toContain('startAt');
    expect(result.perTurnDetail[0].hardSlotMismatches).not.toContain('notes');
  });

  it('PR#265 review — per-turn escalation correlation: escalation only on turn 2 does NOT retroactively mark turn 1 escalated', () => {
    const script = makeScript({
      turns: [
        {
          caller: 'what are your hours',
          expected: { intent: 'business_hours_lookup', escalates: false },
          hangupAfter: false,
        },
        {
          caller: 'I want a manager',
          expected: { intent: 'escalate', escalates: true },
          hangupAfter: false,
        },
      ],
    });
    const obs = makeObservation({
      events: [
        intentEvent('business_hours_lookup', 1_000),
        intentEvent('escalate', 2_000),
        escalationEvent('caller_request', 2_500),
      ],
    });

    const result = gradeDispositionStructured(obs, script);

    expect(result.perTurnDetail[0].actualEscalated).toBe(false);
    expect(result.perTurnDetail[1].actualEscalated).toBe(true);
    expect(result.perTurnDetail[0].escalationMatched).toBe(true);
    expect(result.perTurnDetail[1].escalationMatched).toBe(true);
    expect(result.failedCriteria).not.toContain(11);
  });

  it('PR#265 review — per-turn escalation correlation: escalation between turn 1 and turn 2 is attributed to turn 2', () => {
    const script = makeScript({
      turns: [
        {
          caller: 'first',
          expected: { intent: 'i1', escalates: false },
          hangupAfter: false,
        },
        {
          caller: 'second',
          expected: { intent: 'i2', escalates: true },
          hangupAfter: false,
        },
      ],
    });
    const obs = makeObservation({
      events: [
        intentEvent('i1', 1_000),
        escalationEvent('reason', 1_500),
        intentEvent('i2', 2_000),
      ],
    });

    const result = gradeDispositionStructured(obs, script);

    expect(result.perTurnDetail[0].actualEscalated).toBe(false);
    expect(result.perTurnDetail[1].actualEscalated).toBe(true);
    expect(result.failedCriteria).not.toContain(11);
  });

  it('flaky-fix — same-millisecond escalation is attributed by log order, not ts (sql-injection-text repro)', () => {
    // Event timestamps are `Date.now()` (ms); a fast 2-turn script can emit
    // both classifications AND the final escalation inside one millisecond.
    // The agent classifies before it escalates, so the log order is
    // [intent(turn0), intent(turn1), escalation]. With ts-only windows the
    // tie put the escalation in turn 0 (`<=` upper bound) and stripped it
    // from turn 1 — flipping criterion 11 ~30% of runs. Log-index windows
    // keep the escalation on the (last) turn that actually escalated.
    const script = makeScript({
      turns: [
        {
          caller: "My name is Jane'); DROP TABLE customers; --",
          expected: { intent: 'unknown', escalates: false },
          hangupAfter: false,
        },
        {
          caller: "I'd like to schedule service.",
          expected: { intent: 'create_appointment', escalates: true },
          hangupAfter: false,
        },
      ],
    });
    const obs = makeObservation({
      events: [
        intentEvent('unknown', 1_000),
        intentEvent('create_appointment', 1_000),
        escalationEvent('adversarial_recognized', 1_000),
      ],
    });

    const result = gradeDispositionStructured(obs, script);

    expect(result.perTurnDetail[0].actualEscalated).toBe(false);
    expect(result.perTurnDetail[1].actualEscalated).toBe(true);
    expect(result.failedCriteria).not.toContain(11);
  });

  it('PR#265 review — per-turn escalation correlation: an escalation event in every turn-window marks every turn escalated', () => {
    const script = makeScript({
      turns: [
        {
          caller: 'a',
          expected: { intent: 'i1', escalates: true },
          hangupAfter: false,
        },
        {
          caller: 'b',
          expected: { intent: 'i2', escalates: true },
          hangupAfter: false,
        },
      ],
    });
    const obs = makeObservation({
      events: [
        escalationEvent('r1', 800),
        intentEvent('i1', 1_000),
        escalationEvent('r2', 1_500),
        intentEvent('i2', 2_000),
      ],
    });

    const result = gradeDispositionStructured(obs, script);

    expect(result.perTurnDetail[0].actualEscalated).toBe(true);
    expect(result.perTurnDetail[1].actualEscalated).toBe(true);
    expect(result.failedCriteria).not.toContain(11);
  });

  it('VQ-021 — produces failedCriteria with [9, 10, 11] when all three fail in the same call', () => {
    const script = makeScript({
      turns: [
        {
          caller: 'mess up everything',
          expected: {
            intent: 'book_appointment',
            slots: { customerId: 'c-1' },
            proposalType: 'create_appointment',
            escalates: true,
          },
          hangupAfter: false,
        },
      ],
    });
    const obs = makeObservation({
      events: [intentEvent('cancel_appointment', 1_000)],
      proposals: [makeProposal({ customerId: 'c-OTHER' }, 'create_appointment')],
    });

    const result = gradeDispositionStructured(obs, script);

    expect(result.passed).toBe(false);
    expect([...result.failedCriteria].sort((a, b) => a - b)).toEqual([9, 10, 11]);
    expect(result.reasons[9]).toBeTruthy();
    expect(result.reasons[10]).toBeTruthy();
    expect(result.reasons[11]).toBeTruthy();
  });
});

/**
 * #1222 — life-safety expectations. The corpus could never catch an E1
 * regression: the driver skipped the tier classifier and no grader asked
 * for the tier, the closed call, the evacuation script or the revoked
 * booking. These are graded under criterion 11 (right escalation behavior):
 * for an E1 hazard the RIGHT behavior is to close on the 911 / evacuation
 * script and NOT bridge to the dispatcher.
 */
describe('#1222 — gradeDispositionStructured life-safety expectations', () => {
  const E1_TURN = {
    caller: 'I smell gas in the kitchen.',
    expected: {
      escalates: false,
      safetyTier: 'E1' as const,
      callClosed: true,
      spokenIncludes: ['leave the building', '911'],
      noLiveBooking: true,
    },
    hangupAfter: false,
  };

  function e1Audit(tier: string): Observation['audit'][number] {
    return {
      id: 'a-1',
      tenantId: 't-1',
      actorId: 'calling-agent',
      actorRole: 'system',
      eventType: 'agent.calling.intent_capture.emergency_detected',
      entityType: 'voice_session',
      entityId: 's-1',
      correlationId: 's-1',
      metadata: { tier, toState: 'terminated', reason: 'life_safety_e1' },
      createdAt: new Date(0),
    } as unknown as Observation['audit'][number];
  }

  const E1_EVENTS: VoiceSessionEvent[] = [
    {
      type: 'speech_outbound',
      turnIndex: 0,
      transcript:
        'If anyone is in immediate danger, hang up and call 911 now. If you smell gas, please leave the building immediately.',
      ts: 1_000,
    },
    { type: 'session_terminated', cause: 'life_safety_e1', ts: 1_001 },
  ];

  it('passes a call that was logged E1, closed on the evacuation script, with no live booking', () => {
    const result = gradeDispositionStructured(
      makeObservation({ events: E1_EVENTS, audit: [e1Audit('E1')] }),
      makeScript({ turns: [E1_TURN] }),
    );
    expect(result.passed).toBe(true);
  });

  it('fails criterion 11 when the call was never classified E1', () => {
    const result = gradeDispositionStructured(
      makeObservation({ events: E1_EVENTS, audit: [] }),
      makeScript({ turns: [E1_TURN] }),
    );
    expect(result.failedCriteria).toContain(11);
    expect(result.reasons[11]).toMatch(/E1/);
  });
});

/**
 * #898 — `capEndsCall`: the session cost cap ended the call (one
 * session_terminated{cap_exceeded}) and the agent made no model call after
 * it. The old cost-cap-drain script could only express this in a free-text
 * `spokenAnswerMatches` the Layer 1 mock judge always passes.
 */
describe('#898 — gradeDispositionStructured capEndsCall', () => {
  const turn = {
    caller: 'Anyway, what is your favourite colour?',
    expected: { capEndsCall: true },
    hangupAfter: false,
  };

  it('passes when the cap ended the call and nothing was classified afterwards', () => {
    const result = gradeDispositionStructured(
      makeObservation({
        events: [
          intentEvent('unknown', 1_000),
          { type: 'session_terminated', cause: 'cap_exceeded', ts: 1_001 },
        ],
      }),
      makeScript({ turns: [turn] }),
    );
    expect(result.passed).toBe(true);
  });

  it('fails criterion 11 when the cap never ended the call', () => {
    const result = gradeDispositionStructured(
      makeObservation({ events: [intentEvent('unknown', 1_000)] }),
      makeScript({ turns: [turn] }),
    );
    expect(result.failedCriteria).toContain(11);
  });

  it('fails criterion 11 when the model was still called after the cap ended the call', () => {
    const result = gradeDispositionStructured(
      makeObservation({
        events: [
          { type: 'session_terminated', cause: 'cap_exceeded', ts: 1_000 },
          // The crossing turn's reply, then a LATER turn classifies again.
          { type: 'speech_outbound', transcript: 'Let me connect you.', turnIndex: 0, ts: 1_001 },
          intentEvent('unknown', 1_002),
        ],
      }),
      makeScript({ turns: [turn] }),
    );
    expect(result.failedCriteria).toContain(11);
    expect(result.reasons[11]).toMatch(/after the cost cap/);
  });
});
