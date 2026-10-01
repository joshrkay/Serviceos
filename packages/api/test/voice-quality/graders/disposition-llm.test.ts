/**
 * VQ-022 — Disposition-LLM grader tests.
 *
 * Validates the LLM-as-judge that grades criterion 12 (caller-facing
 * answer matches ground truth) plus the soft slot fields in criterion 10
 * (notes / reason / description text). Driven entirely against
 * `createMockLLMGateway` so tests are deterministic and offline.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createMockLLMGateway } from '../../../src/ai/gateway/factory';
import {
  gradeDispositionLlm,
  resetJudgeCache,
} from '../../../src/ai/voice-quality/graders/disposition-llm';
import type { Observation } from '../../../src/ai/voice-quality/observation';
import type { VoiceQualityScript } from '../../../src/ai/voice-quality/schema';
import type { Proposal } from '../../../src/proposals/proposal';

function makeScript(overrides: Partial<VoiceQualityScript> = {}): VoiceQualityScript {
  return {
    id: 'vq-022-fixture',
    bucket: '01-happy-lookups',
    fixtures: { tenant: {}, customers: [] },
    callerId: '+15551234567',
    callerIdBlocked: false,
    turns: [
      {
        caller: 'When is my next appointment?',
        expected: {
          intent: 'lookup_appointments',
          spokenAnswerMatches: 'Your next appointment is Tuesday at 10am.',
        },
        hangupAfter: false,
      },
    ],
    grading: { appliesFloor: [], appliesDisposition: [10, 12] },
    layer2Eligible: false,
    ...overrides,
  };
}

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    callId: 'call-vq022',
    scriptId: 'vq-022-fixture',
    tenantId: 't-vq022',
    events: [],
    proposals: [] as Proposal[],
    customerCountDelta: 0,
    appointmentCountDelta: 0,
    audit: [],
    totalCostCents: 0,
    totalDurationMs: 1_000,
    perTurnLatencyMs: [800],
    sessionEndedAs: 'completed',
    hangupOccurred: false,
    errors: [],
    ...overrides,
  };
}

function makeProposal(payload: Record<string, unknown>): Proposal {
  return {
    id: 'p-1',
    tenantId: 't-vq022',
    proposalType: 'add_note',
    status: 'ready_for_review',
    payload,
    summary: 'Your next appointment is Tuesday at 10am.',
  } as Proposal;
}

const PASS_RESPONSE = JSON.stringify({
  answerMeaningMatches: true,
  softSlotsReasonable: true,
  rationale: 'looks good',
});

describe('VQ-022 — gradeDispositionLlm', () => {
  beforeEach(() => {
    resetJudgeCache();
  });

  it('VQ-022 — passes when judge says answerMeaningMatches: true AND softSlotsReasonable: true for all turns', async () => {
    const { gateway, provider } = createMockLLMGateway(PASS_RESPONSE);
    const script = makeScript();
    const observation = makeObservation({ proposals: [makeProposal({ note: 'next appt tuesday' })] });

    const result = await gradeDispositionLlm({ observation, script, gateway });

    expect(result.passed).toBe(true);
    expect(result.failedCriteria).toEqual([]);
    expect(result.perTurnDetail).toHaveLength(1);
    expect(result.perTurnDetail[0].answerJudgePass).toBe(true);
    expect(result.perTurnDetail[0].softSlotJudgePass).toBe(true);
    expect(provider.getCalls()).toHaveLength(1);
  });

  it('VQ-022 — fails criterion 12 when judge says answerMeaningMatches: false on any turn', async () => {
    const { gateway } = createMockLLMGateway(
      JSON.stringify({
        answerMeaningMatches: false,
        softSlotsReasonable: true,
        rationale: 'agent gave wrong date',
      }),
    );
    const script = makeScript();
    const observation = makeObservation({ proposals: [makeProposal({})] });

    const result = await gradeDispositionLlm({ observation, script, gateway });

    expect(result.passed).toBe(false);
    expect(result.failedCriteria).toContain(12);
    expect(result.failedCriteria).not.toContain(10);
    expect(result.reasons[12]).toMatch(/wrong date/);
  });

  it('VQ-022 — fails criterion 10 (soft slots) when softSlotsReasonable: false on any turn', async () => {
    const { gateway } = createMockLLMGateway(
      JSON.stringify({
        answerMeaningMatches: true,
        softSlotsReasonable: false,
        rationale: 'note text omits caller-stated reason',
      }),
    );
    const script = makeScript();
    const observation = makeObservation({ proposals: [makeProposal({ note: '' })] });

    const result = await gradeDispositionLlm({ observation, script, gateway });

    expect(result.passed).toBe(false);
    expect(result.failedCriteria).toContain(10);
    expect(result.failedCriteria).not.toContain(12);
    expect(result.reasons[10]).toMatch(/omits caller-stated reason/);
  });

  it('VQ-022 — caches by hash: same input twice → only one judge call', async () => {
    const { gateway, provider } = createMockLLMGateway(PASS_RESPONSE);
    const script = makeScript();
    const observation = makeObservation({ proposals: [makeProposal({ note: 'n' })] });

    await gradeDispositionLlm({ observation, script, gateway });
    await gradeDispositionLlm({ observation, script, gateway });

    expect(provider.getCalls()).toHaveLength(1);
  });

  it('VQ-022 — handles missing spoken answer gracefully', async () => {
    const { gateway, provider } = createMockLLMGateway(PASS_RESPONSE);
    const script = makeScript();
    // No proposals → no spoken answer to grade.
    const observation = makeObservation({ proposals: [] });

    const result = await gradeDispositionLlm({ observation, script, gateway });

    expect(result.passed).toBe(true);
    expect(result.perTurnDetail[0].spokenAnswer).toBeNull();
    expect(result.perTurnDetail[0].judgeRationale).toMatch(/no spoken answer captured/);
    // Skipped: no judge call should happen for a missing answer.
    expect(provider.getCalls()).toHaveLength(0);
  });

  // #1331 — criterion 12 grades what the caller HEARD. Weekly run
  // 36829085635 judged `proposal.summary` ("Add material") as the agent's
  // reply ("too vague"), and never judged a lookup at all (no proposal).
  it('#1331 — judges the captured agent speech for a lookup turn that drafted no proposal', async () => {
    const { gateway, provider } = createMockLLMGateway(PASS_RESPONSE);
    const observation = makeObservation({
      events: [
        { type: 'speech_outbound', transcript: 'Your next appointment is Tuesday at 10 AM.', turnIndex: 0, ts: 1 },
      ],
    });

    await gradeDispositionLlm({ observation, script: makeScript(), gateway });

    expect(provider.getCalls()).toHaveLength(1);
    const userMsg = provider.getCalls()[0].messages.find((m) => m.role === 'user')!.content;
    expect(userMsg).toContain('Agent said: "Your next appointment is Tuesday at 10 AM."');
  });

  it('#1331 — grades the spoken reply, not the operator-card summary, when a turn drafted a proposal', async () => {
    const { gateway, provider } = createMockLLMGateway(PASS_RESPONSE);
    const observation = makeObservation({
      proposals: [{ ...makeProposal({}), summary: 'Add material' } as Proposal],
      events: [
        {
          type: 'speech_outbound',
          transcript: "I've drafted that — it's in your approvals waiting for you to review.",
          turnIndex: 0,
          ts: 1,
        },
      ],
    });

    await gradeDispositionLlm({ observation, script: makeScript(), gateway });

    const userMsg = provider.getCalls()[0].messages.find((m) => m.role === 'user')!.content;
    expect(userMsg).toContain(
      `Agent said: "I've drafted that — it's in your approvals waiting for you to review."`,
    );
    expect(userMsg).not.toContain('Add material');
  });

  // #1331 — run 36895893912: on the phone a write is read back on the
  // request turn and drafted on the caller's yes, so the drafted-reply
  // expectation sits on the yes turn. The judge saw only `Caller said: "Yes,
  // that's right."` + "I've drafted that — it's in your approvals…" and failed
  // 15 scripts for "does not convey the service location" — the detail the
  // caller had just heard in the read-back and confirmed.
  it('#1331 — judges a turn with the agent line the caller was answering (the read-back they confirmed)', async () => {
    const { gateway, provider } = createMockLLMGateway(PASS_RESPONSE);
    const script = makeScript({
      turns: [
        {
          caller: 'Please add a second service address for me at 412 Oak Street.',
          expected: { intent: 'add_service_location', proposalType: 'add_service_location' },
          hangupAfter: false,
        },
        {
          caller: "Yes, that's right.",
          expected: {
            spokenAnswerMatches:
              "I've drafted a new service location for review; an operator will confirm the address before it's added.",
          },
          hangupAfter: false,
        },
      ],
    });
    const observation = makeObservation({
      events: [
        {
          type: 'speech_outbound',
          transcript: "Just to confirm, you'd like to add 412 Oak Street as a service location for Jane. Is that right?",
          turnIndex: 0,
          ts: 1,
        },
        {
          type: 'speech_outbound',
          transcript: "I've drafted that. It's in your approvals waiting for you to review.",
          turnIndex: 1,
          ts: 2,
        },
      ],
    });

    await gradeDispositionLlm({ observation, script, gateway });

    const userMsgs = provider.getCalls().map((c) => c.messages.find((m) => m.role === 'user')!.content);
    const yesTurn = userMsgs.find((m) => m.includes(`Caller said: "Yes, that's right."`))!;
    expect(yesTurn).toContain(
      `Agent's previous line (what the caller was answering): "Just to confirm, you'd like to add 412 Oak Street as a service location for Jane. Is that right?"`,
    );
    const requestTurn = userMsgs.find((m) => m.includes('412 Oak Street.'))!;
    expect(requestTurn).not.toContain("Agent's previous line");
  });

  // #1331 — run 36895893912: the judge failed confirm-appointment's correct
  // read-back as "asks for confirmation, which is unnecessary", failed
  // "Friday, June 12th" as "June 12 is not a Friday in 2023" (it is a Friday
  // in 2026, the corpus world), and blamed the agent for Whisper hearing "PEX"
  // as "pecks". It must grade against the product contract, on the call's date,
  // knowing it reads speech-recognised audio.
  it('#1331 — tells the judge the read-back/draft contract, who is calling, the call date, and that it reads ASR audio', async () => {
    const { gateway, provider } = createMockLLMGateway(PASS_RESPONSE);
    const observation = makeObservation({
      events: [{ type: 'speech_outbound', transcript: 'Your next appointment is Friday, June 12th at 9 a.m.', turnIndex: 0, ts: 1 }],
    });

    await gradeDispositionLlm({ observation, script: makeScript({ callerIsOwner: true }), gateway });

    const [call] = provider.getCalls();
    const system = call.messages.find((m) => m.role === 'system')!.content;
    const user = call.messages.find((m) => m.role === 'user')!.content;
    expect(system).toMatch(/reads (the|a) (write )?request back/i);
    expect(system).toMatch(/in your approvals/i);
    expect(system).toMatch(/speech recogni/i);
    expect(system).toMatch(/One moment/);
    expect(user).toContain('Caller: the business owner, calling their own business line.');
    expect(user).toContain('Call date: Friday, May 1, 2026');

    resetJudgeCache();
    const { gateway: g2, provider: p2 } = createMockLLMGateway(PASS_RESPONSE);
    await gradeDispositionLlm({ observation, script: makeScript(), gateway: g2 });
    expect(p2.getCalls()[0].messages.find((m) => m.role === 'user')!.content).toContain(
      'Caller: a customer of the business.',
    );
  });

  it('VQ-022 — handles missing expected answer (judges for reasonableness only)', async () => {
    const { gateway, provider } = createMockLLMGateway(PASS_RESPONSE);
    const script = makeScript({
      turns: [
        {
          caller: 'just confirm something',
          expected: { intent: 'lookup_appointments' }, // no spokenAnswerMatches
          hangupAfter: false,
        },
      ],
    });
    const observation = makeObservation({ proposals: [makeProposal({ note: 'x' })] });

    const result = await gradeDispositionLlm({ observation, script, gateway });

    expect(result.passed).toBe(true);
    expect(provider.getCalls()).toHaveLength(1);
    const userMsg = provider.getCalls()[0].messages.find((m) => m.role === 'user')!.content;
    // When expected is absent, the prompt explicitly tells the judge to grade for reasonableness.
    expect(userMsg).toMatch(/no explicit expectation/);
  });

  it('VQ-022 — calls cost tracker if provided', async () => {
    const { gateway } = createMockLLMGateway(PASS_RESPONSE);
    const script = makeScript();
    const observation = makeObservation({ proposals: [makeProposal({ note: 'n' })] });

    let total = 0;
    const costTracker = { addCents: (n: number) => { total += n; } };

    await gradeDispositionLlm({ observation, script, gateway, costTracker });

    expect(total).toBeGreaterThan(0);
  });

  it('VQ-022 — invalid JSON from gateway throws clear error', async () => {
    const { gateway } = createMockLLMGateway('not json {{{');
    const script = makeScript();
    const observation = makeObservation({ proposals: [makeProposal({ note: 'n' })] });

    await expect(
      gradeDispositionLlm({ observation, script, gateway }),
    ).rejects.toThrow(/judge.*JSON|invalid.*judge|disposition-llm/i);
  });

  it('VQ-022 — concurrency cap: dispatching 10 turns with batch size 5 results in at most 5 in-flight at once', async () => {
    // We hand-instrument the mock provider to record concurrent in-flight count.
    const { gateway, provider } = createMockLLMGateway(PASS_RESPONSE);
    let inFlight = 0;
    let maxInFlight = 0;
    const originalComplete = provider.complete.bind(provider);
    provider.complete = async (req) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield twice so multiple promises can stack up if concurrency was unbounded.
      await new Promise((r) => setTimeout(r, 5));
      const res = await originalComplete(req);
      inFlight -= 1;
      return res;
    };

    const turns = Array.from({ length: 10 }, (_, i) => ({
      caller: `caller turn ${i}`,
      expected: {
        intent: 'lookup_appointments',
        spokenAnswerMatches: `expected answer ${i}`,
      },
      hangupAfter: false,
    }));
    const script = makeScript({ turns });
    const proposals = turns.map((_, i) => makeProposal({ note: `note ${i}` }));
    const observation = makeObservation({ proposals });

    const result = await gradeDispositionLlm({ observation, script, gateway });

    expect(result.passed).toBe(true);
    expect(provider.getCalls()).toHaveLength(10);
    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBeGreaterThan(1); // sanity: parallelism IS happening
  });
});
