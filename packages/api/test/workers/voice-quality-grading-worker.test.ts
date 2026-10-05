/**
 * #1602 — nightly voice-quality grading worker (P0-009 cross-tenant sweep
 * pattern): samples each tenant's eligible ended inbound calls under the
 * tenant's sample rate + hard daily cap and grades them through
 * `gradeVoiceSession`.
 *
 * Seam: the worker's `handle()` with the in-memory store and a fake judge
 * gateway. Expected counts come from the issue's sampling rule (20% of
 * eligible calls, at least 1 per day, never above the daily cap).
 */
import { describe, it, expect, vi } from 'vitest';
import type { LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';
import { createVoiceSessionGrader } from '../../src/voice/quality/grade-voice-session';
import { InMemoryVoiceSessionGradeStore } from '../../src/voice/quality/voice-session-grade-store';
import { createVoiceQualityGradingWorker } from '../../src/workers/voice-quality-grading-worker';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-05T08:00:00.000Z');

const GOOD_REPLIES: Record<string, string> = {
  voice_quality_perceived_completion: JSON.stringify({
    perceivedSatisfaction: 'good',
    rationale: 'Caller got what they asked for',
    abandonmentRisk: 0,
  }),
  voice_quality_judge: JSON.stringify({
    answerMeaningMatches: true,
    softSlotsReasonable: true,
    rationale: 'Answered the question',
  }),
};

function fakeGateway(replies: Record<string, string> = GOOD_REPLIES) {
  return {
    complete: vi.fn(async (req: LLMRequest): Promise<LLMResponse> => ({
      content: replies[req.taskType] ?? '{}',
      model: 'judge-mock-1',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
      costMicroCents: 100_000,
    })),
  };
}

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** `count` eligible calls for `tenantId` that ended within the last few hours. */
function seedEligibleCalls(store: InMemoryVoiceSessionGradeStore, tenantId: string, count: number) {
  for (let i = 0; i < count; i++) {
    const endedAt = new Date(NOW.getTime() - (i + 1) * 60 * 60 * 1000);
    store.seedSession({
      id: `${tenantId.slice(0, 8)}-0000-4000-8000-${String(i).padStart(12, '0')}`,
      tenantId,
      channel: 'voice_inbound',
      startedAt: new Date(endedAt.getTime() - 120_000),
      endedAt,
      outcome: 'completed',
      transcript: [`caller: Question ${i}`, `agent: Answer ${i}`],
      recordingDisclosed: true,
      billable: true,
    });
  }
}

function buildWorker(store: InMemoryVoiceSessionGradeStore, tenants: string[], gateway = fakeGateway()) {
  const grader = createVoiceSessionGrader({ store, gateway, now: () => NOW });
  return createVoiceQualityGradingWorker({
    store,
    grader,
    listTenantIds: async () => tenants,
    logger: silentLogger,
    now: () => NOW,
  });
}

describe('voice-quality grading worker handle() (#1602)', () => {
  it('grades 20% of a tenant\'s eligible ended inbound calls by default and makes them visible to the owner', async () => {
    const store = new InMemoryVoiceSessionGradeStore();
    seedEligibleCalls(store, TENANT_A, 10);
    const worker = buildWorker(store, [TENANT_A]);

    const result = await worker.handle();

    expect(result).toMatchObject({ tenantsSwept: 1, graded: 2, failures: 0 });
    const summary = await store.summary(TENANT_A, NOW);
    expect(summary.last7d).toEqual({ graded: 2, passed: 2 });
    expect(summary.recent.every((g) => g.trigger === 'nightly')).toBe(true);
  });

  it('grades at least one call a day when the sample would round to zero', async () => {
    const store = new InMemoryVoiceSessionGradeStore();
    seedEligibleCalls(store, TENANT_A, 1);
    const worker = buildWorker(store, [TENANT_A]);

    expect((await worker.handle()).graded).toBe(1);
  });

  it('never grades past the tenant\'s hard daily cap, across repeated runs', async () => {
    const store = new InMemoryVoiceSessionGradeStore();
    seedEligibleCalls(store, TENANT_A, 10);
    store.setQuota(TENANT_A, { sampleRatePct: 100, dailyCap: 3 });
    const worker = buildWorker(store, [TENANT_A]);

    expect((await worker.handle()).graded).toBe(3);
    // Second run the same day: the cap is spent, nothing more is graded.
    expect((await worker.handle()).graded).toBe(0);
    expect((await store.summary(TENANT_A, NOW)).last7d.graded).toBe(3);
  });

  it('isolates a failing tenant: the others are still graded and the failure is counted', async () => {
    const store = new InMemoryVoiceSessionGradeStore();
    seedEligibleCalls(store, TENANT_A, 1);
    seedEligibleCalls(store, TENANT_B, 1);
    const gateway = fakeGateway();
    gateway.complete.mockImplementation(async (req: LLMRequest) => {
      if (req.tenantId === TENANT_A) throw new Error('provider outage');
      return {
        content: GOOD_REPLIES[req.taskType] ?? '{}',
        model: 'judge-mock-1',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      };
    });
    const worker = buildWorker(store, [TENANT_A, TENANT_B], gateway);

    const result = await worker.handle();

    expect(result).toMatchObject({ tenantsSwept: 2, graded: 1, failures: 1 });
    expect((await store.summary(TENANT_B, NOW)).last7d.graded).toBe(1);
    expect((await store.summary(TENANT_A, NOW)).last7d.graded).toBe(0);
  });

  it('on-demand for one tenant grades that tenant now, even outside the nightly hour', async () => {
    const store = new InMemoryVoiceSessionGradeStore();
    seedEligibleCalls(store, TENANT_A, 1);
    seedEligibleCalls(store, TENANT_B, 1);
    const grader = createVoiceSessionGrader({ store, gateway: fakeGateway(), now: () => NOW });
    const worker = createVoiceQualityGradingWorker({
      store,
      grader,
      listTenantIds: async () => [TENANT_A, TENANT_B],
      logger: silentLogger,
      now: () => NOW, // 08:00Z
      nightlyHourUtc: 3,
    });

    // The scheduled tick outside the nightly hour does nothing…
    expect(await worker.handle()).toMatchObject({ ran: false, graded: 0 });
    // …but the owner's trigger grades their tenant right away.
    const manual = await worker.handle({ tenantId: TENANT_A, trigger: 'manual' });
    expect(manual).toMatchObject({ ran: true, tenantsSwept: 1, graded: 1 });
    expect((await store.summary(TENANT_A, NOW)).recent[0]?.trigger).toBe('manual');
    expect((await store.summary(TENANT_B, NOW)).last7d.graded).toBe(0);
  });
});
