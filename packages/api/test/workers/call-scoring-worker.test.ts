/**
 * #1736 — the call-scoring sweep: opt-in per tenant (OFF by default), bounded
 * per tick, failure-isolated, audited. Driven with in-memory stores and a
 * mocked gateway; one scored call = one gateway call.
 */
import { describe, it, expect, vi } from 'vitest';
import type { LLMResponse } from '../../src/ai/gateway/gateway';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryVoiceSessionGradeStore } from '../../src/voice/quality/voice-session-grade-store';
import { InMemoryCallScoreStore } from '../../src/voice/scoring/call-score-store';
import { createVoiceCallScorer } from '../../src/voice/scoring/score-voice-call';
import { createCallScoringWorker, CALL_SCORED_EVENT } from '../../src/workers/call-scoring-worker';

const ON = '11111111-1111-4111-8111-111111111111';
const OFF = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-05T08:00:00.000Z');

const VERDICT = JSON.stringify({
  items: [
    { id: 'booked', verdict: 'pass', rationale: 'ok' },
    { id: 'price_grounded', verdict: 'not_applicable', rationale: 'none' },
    { id: 'escalation_handled', verdict: 'not_applicable', rationale: 'none' },
    { id: 'follow_up_set', verdict: 'pass', rationale: 'ok' },
  ],
  flags: [],
  summary: 'Fine.',
});

function setup(callsPerTenant: Record<string, number>, content = VERDICT) {
  const sessions = new InMemoryVoiceSessionGradeStore();
  const store = new InMemoryCallScoreStore();
  let n = 0;
  for (const [tenantId, count] of Object.entries(callsPerTenant)) {
    for (let i = 0; i < count; i++) {
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      const endedAt = new Date(NOW.getTime() - (i + 1) * 60 * 60 * 1000);
      sessions.seedSession({
        id,
        tenantId,
        channel: 'voice_inbound',
        startedAt: new Date(endedAt.getTime() - 60_000),
        endedAt,
        outcome: 'completed',
        transcript: ['caller: book me', 'agent: Booked.'],
        recordingDisclosed: true,
        billable: true,
      });
      store.seedEligibleCall(tenantId, id, endedAt);
    }
  }
  const gateway = {
    complete: vi.fn(async (): Promise<LLMResponse> => ({
      content,
      model: 'm',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    })),
  };
  const auditRepo = new InMemoryAuditRepository();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const scorer = createVoiceCallScorer({ store, sessions, gateway, now: () => NOW });
  const worker = createCallScoringWorker({
    store,
    scorer,
    listTenantIds: async () => [ON, OFF],
    logger,
    auditRepo,
    now: () => NOW,
    perTenantLimit: 2,
  });
  return { store, gateway, auditRepo, logger, worker };
}

describe('call-scoring worker (#1736)', () => {
  it('does nothing for a tenant that has not opted in', async () => {
    const { worker, gateway, store } = setup({ [OFF]: 3 });
    const result = await worker.handle();
    expect(result).toMatchObject({ tenantsSwept: 0, scored: 0 });
    expect(gateway.complete).not.toHaveBeenCalled();
    expect(await store.listScores(OFF, 10)).toEqual([]);
  });

  it('scores at most perTenantLimit calls per tick for an opted-in tenant, newest first, and audits each', async () => {
    const { worker, store, auditRepo } = setup({ [ON]: 3, [OFF]: 2 });
    await store.setEnabled(ON, true);

    const result = await worker.handle();

    expect(result).toMatchObject({ tenantsSwept: 1, scored: 2, failures: 0 });
    const scored = await store.listScores(ON, 10);
    expect(scored).toHaveLength(2);
    // the two newest calls (1h and 2h old) — not the 3h-old one
    expect(scored.map((s) => s.callEndedAt.getTime())).toEqual([
      NOW.getTime() - 3_600_000,
      NOW.getTime() - 7_200_000,
    ]);
    expect(await store.listScores(OFF, 10)).toEqual([]);
    const events = await auditRepo.findRecentByTenant!(ON, { limit: 10 });
    expect(events.filter((e) => e.eventType === CALL_SCORED_EVENT)).toHaveLength(2);

    // next tick picks up the remaining call
    expect((await worker.handle()).scored).toBe(1);
  });

  it('counts a failing call, logs it and still scores its siblings', async () => {
    const { worker, store, logger, gateway } = setup({ [ON]: 2 });
    await store.setEnabled(ON, true);
    gateway.complete.mockRejectedValueOnce(new Error('provider down'));

    const result = await worker.handle();

    expect(result).toMatchObject({ scored: 1, failures: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      'call-scoring: call scoring failed, skipping',
      expect.objectContaining({ error: 'provider down' }),
    );
  });
});
