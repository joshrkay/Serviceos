/**
 * OBS-2 — a classifier run is found with every other AI run on the same call
 * or conversation.
 *
 * Before: the intent classifier sent sessionId/callSid as trace metadata but
 * no correlationId, so the gateway minted a random ai_runs.correlation_id for
 * every classify_intent run — the strict yes/no confirm (confirmIntent) sent
 * neither. "Every AI run on this call" (WHERE correlation_id = <session>)
 * found the drafting runs but never the routing decisions that led to them.
 *
 * After: `classifierRunMetadata` keys the run to the surface's stable id — the
 * voice session on a call (telephony speechTurn, the Gather seam, in-app), the
 * conversation in chat, the conversation (else the recording) for a memo —
 * the same key that surface's drafting runs carry. One test per classify
 * entry point, each with a mocked gateway.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';
import { classifierRunMetadata } from '../../../src/ai/orchestration/intent-classifier';

const TENANT = 'tenant-obs2-classify';

/** Every request is captured; classify_intent answers with `classification`. */
function capturingGateway(classification: Record<string, unknown>, other: Record<string, string> = {}) {
  const requests: LLMRequest[] = [];
  const gateway = {
    complete: vi.fn(async (req: LLMRequest): Promise<LLMResponse> => {
      requests.push(req);
      const isConfirm = (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent';
      return {
        content: isConfirm
          ? JSON.stringify({ answer: 'yes', reasoning: 'affirmative' })
          : req.taskType === 'classify_intent'
            ? JSON.stringify(classification)
            : other[req.taskType] ?? '{}',
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      };
    }),
  } as unknown as LLMGateway;
  const classifyRuns = () =>
    requests.filter(
      (r) =>
        r.taskType === 'classify_intent' &&
        (r.metadata as { skill?: string } | undefined)?.skill !== 'confirm_intent',
    );
  const confirmRuns = () =>
    requests.filter((r) => (r.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent');
  return { gateway, requests, classifyRuns, confirmRuns };
}

describe('classifierRunMetadata', () => {
  it('keys the run to the session (voice session or conversation) and keeps the trace fields', () => {
    expect(classifierRunMetadata({ tenantId: TENANT, sessionId: 'sess-1', callSid: 'CA1' })).toEqual({
      tenantId: TENANT,
      sessionId: 'sess-1',
      callSid: 'CA1',
      correlationId: 'sess-1',
    });
  });

  it('falls back to the call sid, and an explicit correlation id wins', () => {
    expect(classifierRunMetadata({ tenantId: TENANT, callSid: 'CA1' }).correlationId).toBe('CA1');
    expect(
      classifierRunMetadata({ tenantId: TENANT, sessionId: 'conv-1', correlationId: 'rec-1' }).correlationId,
    ).toBe('rec-1');
  });

  it('with no id at all sends no correlation id (the gateway mints one), never an empty string', () => {
    expect(classifierRunMetadata({ tenantId: TENANT })).toEqual({ tenantId: TENANT });
    expect(classifierRunMetadata({ tenantId: TENANT, sessionId: '' })).toEqual({ tenantId: TENANT });
  });
});

describe('OBS-2 — every classify entry point keys its run to the call or conversation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('telephony speechTurn: the classify and the strict confirm are keyed to the voice session', async () => {
    const { createVoiceTurnProcessor } = await import('../../../src/ai/voice-turn');
    const { VoiceSessionStore } = await import('../../../src/ai/agents/customer-calling/voice-session-store');
    const { InMemoryProposalRepository } = await import('../../../src/proposals/proposal');
    const { InMemoryAuditRepository } = await import('../../../src/audit/audit');
    const { gateway, classifyRuns, confirmRuns } = capturingGateway({
      intentType: 'draft_estimate',
      confidence: 0.95,
      reasoning: 'quote request',
      extractedEntities: { customerName: 'Acme', jobDescription: 'water heater replacement' },
    });
    const store = new VoiceSessionStore({ startInterval: false });
    try {
      const session = store.create(TENANT, 'telephony', { callSid: 'CA-obs2' });
      session.machine.dispatch({
        type: 'incoming_call',
        callSid: 'CA-obs2',
        from: '+15125550100',
        to: '+15125550999',
        tenantId: TENANT,
      });
      session.machine.dispatch({ type: 'greeted_ok' });
      session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
      session.customerId = 'cust-1';
      const processor = createVoiceTurnProcessor({
        store,
        gateway,
        businessName: 'Acme Plumbing',
        systemActorId: 'test-actor',
        auditRepo: new InMemoryAuditRepository(),
        proposalRepo: new InMemoryProposalRepository(),
      });

      await processor.speechTurn({
        session,
        speechResult: 'I would like a quote for a water heater replacement',
        callSid: 'CA-obs2',
        tenantId: TENANT,
      });
      expect(session.machine.currentState).toBe('intent_confirm');
      await processor.speechTurn({ session, speechResult: 'yes please', callSid: 'CA-obs2', tenantId: TENANT });

      expect(classifyRuns().length).toBeGreaterThan(0);
      for (const req of classifyRuns()) {
        expect(req.metadata).toMatchObject({ correlationId: session.id, sessionId: session.id, callSid: 'CA-obs2' });
      }
      expect(confirmRuns()).toHaveLength(1);
      expect(confirmRuns()[0].metadata).toMatchObject({
        correlationId: session.id,
        sessionId: session.id,
        callSid: 'CA-obs2',
        skill: 'confirm_intent',
      });
    } finally {
      store.dispose();
    }
  });

  it('the Twilio Gather seam: the classify is keyed to the voice session', async () => {
    const { TwilioGatherAdapter } = await import('../../../src/telephony/twilio-adapter');
    const { VoiceSessionStore } = await import('../../../src/ai/agents/customer-calling/voice-session-store');
    const { gateway, classifyRuns } = capturingGateway({
      intentType: 'draft_estimate',
      confidence: 0.95,
      reasoning: 'quote request',
      extractedEntities: { customerName: 'Acme' },
    });
    const store = new VoiceSessionStore({ startInterval: false });
    try {
      const adapter = new TwilioGatherAdapter({
        store,
        gateway,
        businessName: 'Acme Plumbing',
        publicBaseUrl: 'https://example.com',
      });
      await adapter.handleInbound({
        callSid: 'CA-gather-obs2',
        from: '+15125550100',
        to: '+15125550999',
        tenantId: TENANT,
      });
      const [sessionId] = Array.from(
        (store as unknown as { sessions: Map<string, unknown> }).sessions.keys(),
      ) as string[];
      const session = await store.get(sessionId);
      if (session && session.machine.currentState === 'ask_caller') {
        session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
      }
      await adapter.handleGather({
        sessionId,
        callSid: 'CA-gather-obs2',
        speechResult: 'I need a quote for a water heater',
        confidence: 0.95,
        tenantId: TENANT,
      });

      expect(classifyRuns().length).toBeGreaterThan(0);
      for (const req of classifyRuns()) {
        expect(req.metadata).toMatchObject({ correlationId: sessionId, sessionId });
      }
    } finally {
      store.dispose();
    }
  });

  it('in-app voice: the classify is keyed to the voice session', async () => {
    const { InAppVoiceAdapter } = await import('../../../src/ai/agents/customer-calling/inapp-adapter');
    const { VoiceSessionStore } = await import('../../../src/ai/agents/customer-calling/voice-session-store');
    const { InMemoryProposalRepository } = await import('../../../src/proposals/proposal');
    const { InMemoryAuditRepository } = await import('../../../src/audit/audit');
    const { InMemoryOnCallRepository } = await import('../../../src/oncall/rotation');
    const { gateway, classifyRuns } = capturingGateway({
      intentType: 'draft_estimate',
      confidence: 0.95,
      extractedEntities: { customerName: 'Acme' },
    });
    const store = new VoiceSessionStore({ startInterval: false });
    try {
      const adapter = new InAppVoiceAdapter({
        store,
        gateway,
        proposalRepo: new InMemoryProposalRepository(),
        auditRepo: new InMemoryAuditRepository(),
        onCallRepo: new InMemoryOnCallRepository(),
      });
      const { sessionId } = await adapter.startSession(TENANT, 'user-obs2', 'conv-inapp-obs2');
      await adapter.handleInput(sessionId, 'Quote a water heater replacement for Acme');

      expect(classifyRuns().length).toBeGreaterThan(0);
      for (const req of classifyRuns()) {
        expect(req.metadata).toMatchObject({ correlationId: sessionId, sessionId });
      }
    } finally {
      store.dispose();
    }
  });

  it('assistant chat: the classify is keyed to the conversation, like the drafting run it routes to', async () => {
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const { createAssistantRouter } = await import('../../../src/routes/assistant');
    const { InMemoryProposalRepository } = await import('../../../src/proposals/proposal');
    const { gateway, requests, classifyRuns } = capturingGateway(
      {
        intentType: 'update_job',
        confidence: 0.95,
        extractedEntities: { jobReference: 'the Miller job', status: 'completed' },
      },
      { update_job: JSON.stringify({ jobReference: 'the Miller job', status: 'completed', confidence_score: 0.8 }) },
    );
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { auth: Record<string, string> }).auth = {
        userId: 'u',
        sessionId: 's',
        tenantId: TENANT,
        role: 'owner',
      };
      next();
    });
    app.use('/api/assistant', createAssistantRouter({ gateway, proposalRepo: new InMemoryProposalRepository() }));
    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Mark the Miller job completed' }] });
    expect(res.status).toBe(200);
    const conversationId = res.body.conversationId as string;
    expect(conversationId).toBeTruthy();

    expect(classifyRuns().length).toBeGreaterThan(0);
    for (const req of classifyRuns()) {
      expect(req.metadata).toMatchObject({ correlationId: conversationId, sessionId: conversationId });
    }
    const drafting = requests.find((r) => r.taskType === 'update_job');
    expect(drafting?.metadata?.correlationId).toBe(conversationId);
  });

  async function routeMemo(payload: Record<string, unknown>) {
    const { createVoiceActionRouterWorker } = await import('../../../src/workers/voice-action-router');
    const { InMemoryProposalRepository } = await import('../../../src/proposals/proposal');
    const capture = capturingGateway(
      {
        intentType: 'update_job',
        confidence: 0.95,
        extractedEntities: { jobReference: 'the Miller job', status: 'completed' },
      },
      { update_job: JSON.stringify({ jobReference: 'the Miller job', status: 'completed', confidence_score: 0.8 }) },
    );
    const worker = createVoiceActionRouterWorker({
      gateway: capture.gateway,
      proposalRepo: new InMemoryProposalRepository(),
    });
    await worker.handle(
      {
        id: 'm',
        type: 'voice_action_router',
        payload: { tenantId: TENANT, userId: 'u', transcript: 'Mark the Miller job completed', ...payload },
        attempts: 1,
        maxAttempts: 3,
        idempotencyKey: 'k',
        createdAt: new Date().toISOString(),
      },
      { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never,
    );
    return capture;
  }

  it('voice memo: the classify is keyed to the conversation, like its drafting run', async () => {
    const { requests, classifyRuns } = await routeMemo({ conversationId: 'conv-memo-obs2' });
    expect(classifyRuns().length).toBeGreaterThan(0);
    for (const req of classifyRuns()) {
      expect(req.metadata).toMatchObject({ correlationId: 'conv-memo-obs2', sessionId: 'conv-memo-obs2' });
    }
    expect(requests.find((r) => r.taskType === 'update_job')?.metadata?.correlationId).toBe('conv-memo-obs2');
  });

  it('voice memo with no conversation: the classify is keyed to the recording, like its drafting run', async () => {
    const { requests, classifyRuns } = await routeMemo({ recordingId: 'rec-memo-obs2' });
    expect(classifyRuns().length).toBeGreaterThan(0);
    for (const req of classifyRuns()) {
      expect(req.metadata?.correlationId).toBe('rec-memo-obs2');
      expect(req.metadata?.sessionId).toBeUndefined();
    }
    expect(requests.find((r) => r.taskType === 'update_job')?.metadata?.correlationId).toBe('rec-memo-obs2');
  });

  it('confirmIntent on its own: keyed to the session it is given, and to nothing without one', async () => {
    const { confirmIntent } = await import('../../../src/ai/skills/confirm-intent');
    const { gateway, confirmRuns } = capturingGateway({});
    await confirmIntent({
      intentSummary: 'book a tune-up',
      callerResponse: 'yes',
      tenantId: TENANT,
      gateway,
      sessionId: 'sess-confirm',
      callSid: 'CA-confirm',
    });
    await confirmIntent({ intentSummary: 'book a tune-up', callerResponse: 'yes', tenantId: TENANT, gateway });
    expect(confirmRuns()[0].metadata).toEqual({
      tenantId: TENANT,
      skill: 'confirm_intent',
      sessionId: 'sess-confirm',
      callSid: 'CA-confirm',
      correlationId: 'sess-confirm',
    });
    expect(confirmRuns()[1].metadata).toEqual({ tenantId: TENANT, skill: 'confirm_intent' });
  });
});
