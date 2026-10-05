/**
 * #1602 — `gradeVoiceSession`: production call grading over the EXISTING
 * Layer 2 graders (perceived-completion + disposition-LLM on the stored
 * transcript; floor #3 from stored timing markers where present).
 *
 * Seam: the service, driven with a fake LLM gateway and the in-memory grade
 * store. Expected pass/fail values come from the graders' own documented
 * contracts (perceived-completion passes when satisfaction is not `poor` AND
 * abandonment risk is not 2; disposition passes when the judge says the
 * answer meaning matches) and the rationales come straight from the judge
 * replies — never recomputed from the implementation.
 */
import { describe, it, expect, vi } from 'vitest';
import type { LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';
import { createVoiceSessionGrader } from '../../../src/voice/quality/grade-voice-session';
import { InMemoryVoiceSessionGradeStore } from '../../../src/voice/quality/voice-session-grade-store';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-10-05T08:00:00.000Z');
const ENDED_AT = new Date('2026-10-04T15:02:00.000Z');

/** One canned judge reply per taskType, with a fixed model + cost per call. */
function fakeGateway(repliesByTaskType: Record<string, string>) {
  const requests: LLMRequest[] = [];
  const complete = vi.fn(async (req: LLMRequest): Promise<LLMResponse> => {
    requests.push(req);
    const content = repliesByTaskType[req.taskType];
    if (content === undefined) throw new Error(`unexpected taskType ${req.taskType}`);
    return {
      content,
      model: 'judge-mock-1',
      provider: 'mock',
      tokenUsage: { input: 10, output: 5, total: 15 },
      latencyMs: 1,
      costMicroCents: 250_000,
    };
  });
  return { complete, requests };
}

const GOOD_CALL_REPLIES = {
  voice_quality_perceived_completion: JSON.stringify({
    perceivedSatisfaction: 'good',
    rationale: 'Caller got the appointment time without friction',
    abandonmentRisk: 0,
  }),
  voice_quality_judge: JSON.stringify({
    answerMeaningMatches: true,
    softSlotsReasonable: true,
    rationale: 'Gave the appointment day and time directly',
  }),
};

function seedDisclosedBillableCall(store: InMemoryVoiceSessionGradeStore) {
  store.seedSession({
    id: SESSION,
    tenantId: TENANT,
    channel: 'voice_inbound',
    startedAt: new Date('2026-10-04T15:00:00.000Z'),
    endedAt: ENDED_AT,
    outcome: 'completed',
    transcript: [
      'agent: Thanks for calling Rivera Plumbing. This call may be recorded.',
      'caller: When is my next appointment?',
      'agent: Your next appointment is Tuesday at 10am.',
    ],
    recordingDisclosed: true,
    billable: true,
    timezone: 'America/Phoenix',
  });
}

describe('gradeVoiceSession (#1602)', () => {
  it('grades an ended, disclosed, billable inbound call and keeps per-criterion pass/fail with the judge rationale', async () => {
    const store = new InMemoryVoiceSessionGradeStore();
    seedDisclosedBillableCall(store);
    const gateway = fakeGateway(GOOD_CALL_REPLIES);

    const grader = createVoiceSessionGrader({ store, gateway, now: () => NOW });
    const result = await grader.gradeVoiceSession(TENANT, SESSION);

    expect(result.status).toBe('graded');
    if (result.status !== 'graded') throw new Error('unreachable');
    const grade = result.grade;
    expect(grade.passed).toBe(true);
    expect(grade.criteria).toEqual(
      expect.arrayContaining([
        {
          grader: 'perceived_completion',
          criterion: 12,
          name: 'rightCallerFacingAnswer',
          passed: true,
          rationale: 'Caller got the appointment time without friction',
        },
        {
          grader: 'disposition_llm',
          criterion: 12,
          name: 'rightCallerFacingAnswer',
          passed: true,
          rationale: 'Gave the appointment day and time directly',
        },
        {
          grader: 'disposition_llm',
          criterion: 10,
          name: 'rightSlotsExtracted',
          passed: true,
          rationale: 'Gave the appointment day and time directly',
        },
      ]),
    );
    // Transcript-only grading: the judge saw the caller's words and the
    // agent's reply, and never an audio reference.
    const judgePrompts = gateway.requests.map((r) => r.messages.map((m) => m.content).join('\n'));
    expect(judgePrompts.some((p) => p.includes('When is my next appointment?'))).toBe(true);
    expect(judgePrompts.some((p) => p.includes('Your next appointment is Tuesday at 10am.'))).toBe(true);
    // Model + bounded cost are recorded on the grade: one perceived-completion
    // call plus one disposition judge call for the single caller turn.
    expect(grade.model).toBe('judge-mock-1');
    expect(grade.judgeCalls).toBe(2);
    expect(grade.costMicroCents).toBe(500_000);
    expect(grade.callEndedAt).toEqual(ENDED_AT);
    // The grade is now readable through the store's owner-facing summary.
    const summary = await store.summary(TENANT, NOW);
    expect(summary.recent.map((g) => g.sessionId)).toEqual([SESSION]);
    expect(summary.last7d).toEqual({ graded: 1, passed: 1 });
  });

  it('consent gate: a call that never carried the recording disclosure is not graded and costs no judge call', async () => {
    const store = new InMemoryVoiceSessionGradeStore();
    store.seedSession({
      id: SESSION,
      tenantId: TENANT,
      channel: 'voice_inbound',
      startedAt: new Date('2026-10-04T15:00:00.000Z'),
      endedAt: ENDED_AT,
      outcome: 'completed',
      transcript: ['caller: Hi', 'agent: Hello'],
      recordingDisclosed: false,
      billable: true,
    });
    const gateway = fakeGateway(GOOD_CALL_REPLIES);
    const grader = createVoiceSessionGrader({ store, gateway, now: () => NOW });

    const result = await grader.gradeVoiceSession(TENANT, SESSION);

    expect(result).toEqual({ status: 'skipped', reason: 'no_disclosure' });
    expect(gateway.complete).not.toHaveBeenCalled();
    expect((await store.summary(TENANT, NOW)).recent).toEqual([]);
  });

  it('skips the owner / business-phone test call (call_usage_events billable = false)', async () => {
    const store = new InMemoryVoiceSessionGradeStore();
    store.seedSession({
      id: SESSION,
      tenantId: TENANT,
      channel: 'voice_inbound',
      startedAt: new Date('2026-10-04T15:00:00.000Z'),
      endedAt: ENDED_AT,
      outcome: 'completed',
      transcript: ['caller: Testing my line', 'agent: Hello, owner'],
      recordingDisclosed: true,
      billable: false,
    });
    const gateway = fakeGateway(GOOD_CALL_REPLIES);
    const grader = createVoiceSessionGrader({ store, gateway, now: () => NOW });

    expect(await grader.gradeVoiceSession(TENANT, SESSION)).toEqual({
      status: 'skipped',
      reason: 'not_billable',
    });
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('fails the call when the judge calls it poor, keeping the failing rationale', async () => {
    const store = new InMemoryVoiceSessionGradeStore();
    seedDisclosedBillableCall(store);
    const gateway = fakeGateway({
      voice_quality_perceived_completion: JSON.stringify({
        perceivedSatisfaction: 'poor',
        rationale: 'Caller asked twice and never got the appointment time',
        abandonmentRisk: 2,
      }),
      voice_quality_judge: JSON.stringify({
        answerMeaningMatches: false,
        softSlotsReasonable: true,
        rationale: 'Agent gave a different day than the caller asked about',
      }),
    });
    const grader = createVoiceSessionGrader({ store, gateway, now: () => NOW });

    const result = await grader.gradeVoiceSession(TENANT, SESSION);

    expect(result.status).toBe('graded');
    if (result.status !== 'graded') throw new Error('unreachable');
    expect(result.grade.passed).toBe(false);
    expect(result.grade.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          grader: 'perceived_completion',
          passed: false,
          rationale: 'Caller asked twice and never got the appointment time',
        }),
        expect.objectContaining({
          grader: 'disposition_llm',
          criterion: 12,
          passed: false,
          rationale: 'Turn 0: Agent gave a different day than the caller asked about',
        }),
        expect.objectContaining({ grader: 'disposition_llm', criterion: 10, passed: true }),
      ]),
    );
    expect((await store.summary(TENANT, NOW)).last7d).toEqual({ graded: 1, passed: 0 });
  });

  it('grades floor #3 (no hang) from stored timing markers, and leaves it out when none were stored', async () => {
    const store = new InMemoryVoiceSessionGradeStore();
    seedDisclosedBillableCall(store);
    // 8 seconds between the caller finishing and the agent starting to speak:
    // over the floor's 7s hard cap.
    store.seedSession({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      tenantId: TENANT,
      channel: 'voice_inbound',
      startedAt: new Date('2026-10-04T16:00:00.000Z'),
      endedAt: new Date('2026-10-04T16:01:00.000Z'),
      outcome: 'completed',
      transcript: ['caller: Do you do water heaters?', 'agent: Yes, we install and repair them.'],
      recordingDisclosed: true,
      billable: true,
      turnTimings: [
        { speaker: 'caller', startedAt: new Date('2026-10-04T16:00:10.000Z') },
        { speaker: 'agent', startedAt: new Date('2026-10-04T16:00:18.000Z') },
      ],
    });
    const gateway = fakeGateway(GOOD_CALL_REPLIES);
    const grader = createVoiceSessionGrader({ store, gateway, now: () => NOW });

    const slow = await grader.gradeVoiceSession(TENANT, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    if (slow.status !== 'graded') throw new Error('unreachable');
    expect(slow.grade.passed).toBe(false);
    expect(slow.grade.criteria).toEqual(
      expect.arrayContaining([
        {
          grader: 'floor',
          criterion: 3,
          name: 'noHang',
          passed: false,
          rationale: 'Turn latency 8000ms exceeds hard cap 7000ms',
        },
      ]),
    );

    const noTimings = await grader.gradeVoiceSession(TENANT, SESSION);
    if (noTimings.status !== 'graded') throw new Error('unreachable');
    expect(noTimings.grade.criteria.some((c) => c.grader === 'floor')).toBe(false);
  });

  it('reads timing markers in turn order, so a reply row that landed before its caller row is not a hang', async () => {
    const store = new InMemoryVoiceSessionGradeStore();
    // Markers are persisted fire-and-forget: the agent's row for turn 1 was
    // stamped 100ms BEFORE the caller's row for turn 0. In turn order the
    // reply still answers the caller; by timestamp it would look like a 60s wait.
    store.seedSession({
      id: SESSION,
      tenantId: TENANT,
      channel: 'voice_inbound',
      startedAt: new Date('2026-10-04T16:00:00.000Z'),
      endedAt: new Date('2026-10-04T16:01:00.000Z'),
      outcome: 'completed',
      transcript: ['caller: Do you do water heaters?', 'agent: Yes, we install and repair them.'],
      recordingDisclosed: true,
      billable: true,
      turnTimings: [
        { speaker: 'caller', startedAt: new Date('2026-10-04T16:00:10.100Z') },
        { speaker: 'agent', startedAt: new Date('2026-10-04T16:00:10.000Z') },
      ],
    });
    const grader = createVoiceSessionGrader({ store, gateway: fakeGateway(GOOD_CALL_REPLIES), now: () => NOW });

    const result = await grader.gradeVoiceSession(TENANT, SESSION);
    if (result.status !== 'graded') throw new Error('unreachable');
    expect(result.grade.criteria).toEqual(
      expect.arrayContaining([expect.objectContaining({ grader: 'floor', criterion: 3, passed: true })]),
    );
  });
});
