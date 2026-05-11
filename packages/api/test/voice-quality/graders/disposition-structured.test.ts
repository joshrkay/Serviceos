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
