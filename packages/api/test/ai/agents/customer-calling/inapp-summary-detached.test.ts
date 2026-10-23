/**
 * TI-01 — the in-app session summary is fire-and-forget: the route has
 * already answered (204 on DELETE, the turn's JSON on an FSM-ended input)
 * when its gateway call — and the ai_runs UPDATE after it — runs. It must not
 * inherit the request's tenant context, whose pg client is back in the pool
 * by then and, pg-pool being LIFO, usually inside the next request's
 * transaction (often another tenant's).
 *
 * Seam: InAppVoiceAdapter (startSession / handleInput / endSession) with a
 * mocked gateway that records the AsyncLocalStorage entry the summary call
 * sees. The adapter calls run inside a published request context, exactly as
 * they would under the /api request transaction.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PoolClient } from 'pg';
import { InAppVoiceAdapter } from '../../../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../../../src/oncall/rotation';
import { tenantContextStore } from '../../../../src/middleware/tenant-context';
import type { LLMGateway, LLMRequest } from '../../../../src/ai/gateway/gateway';

const TENANT = 'tenant-summary-detached';
const UNKNOWN = JSON.stringify({ intentType: 'unknown', confidence: 0.5, extractedEntities: {} });

describe('InAppVoiceAdapter — the background summary runs outside the request tenant context (TI-01)', () => {
  let store: VoiceSessionStore;
  let summaryContexts: unknown[];
  let adapter: InAppVoiceAdapter;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
    summaryContexts = [];
    const complete = vi.fn(async (req: LLMRequest) => {
      if (req.taskType === 'summarize_conversation') {
        // The raw store, deliberately: a closed-but-inherited entry counts too.
        summaryContexts.push(tenantContextStore.getStore());
      }
      return {
        content: UNKNOWN,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      };
    });
    adapter = new InAppVoiceAdapter({
      store,
      gateway: { complete } as unknown as LLMGateway,
      proposalRepo: new InMemoryProposalRepository(),
      auditRepo: new InMemoryAuditRepository(),
      onCallRepo: new InMemoryOnCallRepository(new Map()),
    });
  });
  afterEach(() => store.dispose());

  const inRequest = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContextStore.run({ client: {} as PoolClient, tenantId: TENANT }, fn);

  it('DELETE /voice/sessions/:id — endSession', async () => {
    const { sessionId } = await adapter.startSession(TENANT, 'user-1');

    await inRequest(() => adapter.endSession(sessionId));

    await vi.waitFor(() => expect(summaryContexts).toHaveLength(1));
    expect(summaryContexts[0]).toBeUndefined();
  });

  it('a turn that ends the session (farewell) — handleInput', async () => {
    const { sessionId } = await adapter.startSession(TENANT, 'user-1');
    await adapter.handleInput(sessionId, 'Hmm, can you look at the thing?');

    const turn = await inRequest(() =>
      adapter.handleInput(sessionId, 'Never mind, that is all for now. Goodbye.'),
    );

    expect(turn.ended).toBe(true);
    await vi.waitFor(() => expect(summaryContexts).toHaveLength(1));
    expect(summaryContexts[0]).toBeUndefined();
  });
});

describe('InAppVoiceAdapter — the end-of-call summary is persisted through deps.callSummaryRepo (A2)', () => {
  it('endSession writes the summary row through the repository, and a failed write never fails the teardown', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    try {
      const create = vi.fn().mockRejectedValueOnce(new Error('insert failed')).mockResolvedValue({ id: 'cs-1' });
      const complete = vi.fn(async (req: LLMRequest) => ({
        content:
          req.taskType === 'summarize_conversation' ? JSON.stringify({ summary: 'Operator checked the day.' }) : UNKNOWN,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      }));
      const adapter = new InAppVoiceAdapter({
        store,
        gateway: { complete } as unknown as LLMGateway,
        proposalRepo: new InMemoryProposalRepository(),
        auditRepo: new InMemoryAuditRepository(),
        onCallRepo: new InMemoryOnCallRepository(new Map()),
        callSummaryRepo: { create },
      });

      // The first session's write fails: endSession still resolves.
      const first = await adapter.startSession(TENANT, 'user-1');
      await adapter.endSession(first.sessionId);
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));

      const second = await adapter.startSession(TENANT, 'user-1');
      await adapter.endSession(second.sessionId);
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
      expect(create).toHaveBeenLastCalledWith(TENANT, {
        callId: null,
        summary: 'Operator checked the day.',
        detectedIntent: null,
        proposalIds: [],
        qualityScore: null,
      });
    } finally {
      store.dispose();
    }
  });
});
