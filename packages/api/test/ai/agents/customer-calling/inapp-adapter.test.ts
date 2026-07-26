import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InAppVoiceAdapter, buildInappGreeting } from '../../../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../../../src/oncall/rotation';
import { InMemoryVoiceSessionRepository } from '../../../../src/voice/voice-session';
import type { LLMGateway, LLMResponse } from '../../../../src/ai/gateway/gateway';
import type { TtsProvider } from '../../../../src/ai/tts/tts-provider';
import type { SchedulingEntityResolution } from '../../../../src/ai/agents/customer-calling/entity-resolution';
import type { CallingAgentEvent, SideEffect } from '../../../../src/ai/agents/customer-calling/types';
import type { VoiceSession } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryCatalogItemRepository, createCatalogItem } from '../../../../src/catalog/catalog-item';
import type { CatalogPricingOutcome } from '../../../../src/ai/resolution/catalog-resolver';
import {
  DraftEstimateExecutionHandler,
} from '../../../../src/proposals/execution/handlers';
import {
  SendEstimateExecutionHandler,
  NoopEstimateDeliveryProvider,
} from '../../../../src/proposals/execution/voice-extended-handlers';
import { InMemoryCustomerRepository } from '../../../../src/customers/customer';
import type { Customer } from '../../../../src/customers/customer';
import type { EntityResolver } from '../../../../src/ai/resolution/entity-resolver';

const TENANT = 'tenant-x';
const USER = 'user-x';

function scriptedGateway(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => {
      const content = responses[Math.min(i++, responses.length - 1)];
      return {
        content,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      } satisfies LLMResponse;
    }),
  } as unknown as LLMGateway;
}

function throwingGateway(code?: string): LLMGateway {
  return {
    complete: vi.fn(async () => {
      const error = new Error('sensitive provider detail must not escape');
      if (code) Object.assign(error, { code });
      throw error;
    }),
  } as unknown as LLMGateway;
}

function noopTts(): TtsProvider {
  return {
    synthesize: vi.fn(async (input) => ({
      audio: Buffer.from(`tts:${input.text.slice(0, 12)}`),
      contentType: 'audio/mpeg',
      provider: 'noop',
    })),
  };
}

describe('InAppVoiceAdapter', () => {
  let store: VoiceSessionStore;
  let proposalRepo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;
  let onCallRepo: InMemoryOnCallRepository;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
    proposalRepo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
    onCallRepo = new InMemoryOnCallRepository();
  });

  afterEach(() => {
    store.dispose();
  });

  it('startSession returns a session id, state, and greeting', async () => {
    const gateway = scriptedGateway([]);
    const adapter = new InAppVoiceAdapter({
      store,
      gateway,
      ttsProvider: noopTts(),
      proposalRepo,
      auditRepo,
      onCallRepo,
    });
    const result = await adapter.startSession(TENANT, USER);
    expect(result.sessionId).toBeTruthy();
    expect(result.state).toBe('intent_capture');
    expect(result.greetingText).toMatch(/help/i);
    expect(result.greetingAudio).toBeInstanceOf(Buffer);
  });

  it('does not use the authenticated operator id as a caller customer id', async () => {
    const callerPlanResolver = vi.fn(async () => undefined);
    const adapter = new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway([]),
      proposalRepo,
      auditRepo,
      onCallRepo,
      callerPlanResolver,
    });

    const { sessionId } = await adapter.startSession(TENANT, USER);
    const session = store.peek(sessionId);

    expect(session?.machine.currentContext.customerId).toBeUndefined();
    expect(callerPlanResolver).not.toHaveBeenCalled();
  });

  it('answers an authenticated owner lookup without mutation confirmation', async () => {
    const ownerLookupResolver = vi.fn(async () => 'You have two appointments today.');
    const adapter = new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway([
        JSON.stringify({
          intentType: 'lookup_day_overview',
          confidence: 0.98,
          extractedEntities: {},
        }),
      ]),
      proposalRepo,
      auditRepo,
      onCallRepo,
      extendedIntentsEnabled: async () => true,
      ownerLookupResolver,
    });

    const { sessionId } = await adapter.startSession(TENANT, USER, undefined, 'owner');
    const result = await adapter.handleInput(sessionId, 'What appointments are scheduled today?');

    expect(result.state).toBe('intent_capture');
    expect(result.ttsText).toBe('You have two appointments today.');
    expect(result.proposalIds).toHaveLength(0);
    expect(ownerLookupResolver).toHaveBeenCalledWith(TENANT, sessionId, 'lookup_day_overview');
  });

  it('happy path: high-confidence intent creates a proposal and closes', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'create_invoice',
        confidence: 0.94,
        extractedEntities: { customerName: 'Acme', amount: 45000 },
      }),
    ]);
    const adapter = new InAppVoiceAdapter({
      store,
      gateway,
      proposalRepo,
      auditRepo,
      onCallRepo,
    });
    const { sessionId } = await adapter.startSession(TENANT, USER);
    // Turn 1: high-confidence intent resolves and parks at the readback
    // (intent_confirm) — no proposal is created without caller confirmation.
    const readback = await adapter.handleInput(sessionId, 'Invoice Acme for 450');
    expect(readback.state).toBe('intent_confirm');
    expect(readback.proposalIds.length).toBe(0);
    // Turn 2: the caller confirms — NOW the proposal is created and we close.
    const result = await adapter.handleInput(sessionId, 'yes');
    expect(result.proposalIds.length).toBe(1);
    expect(result.state).toBe('closing');
    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals.length).toBe(1);
    expect(proposals[0].proposalType).toBe('draft_invoice');
    expect(proposals[0].status).toBe('ready_for_review');
  });

  it('low confidence reprompts and stays in intent_capture', async () => {
    const gateway = scriptedGateway([
      // classifier returns unknown / low conf
      JSON.stringify({ intentType: 'unknown', confidence: 0.2 }),
    ]);
    const adapter = new InAppVoiceAdapter({
      store,
      gateway,
      proposalRepo,
      auditRepo,
      onCallRepo,
    });
    const { sessionId } = await adapter.startSession(TENANT, USER);
    const result = await adapter.handleInput(sessionId, 'umm what');
    // FSM reprompts on first low-confidence event (retry < max).
    expect(result.state).toBe('intent_capture');
    expect(result.proposalIds.length).toBe(0);
    expect(
      result.sideEffects.some((effect) =>
        String(effect.payload.eventType).startsWith('classifier_')),
    ).toBe(false);
  });

  describe('classifier failure classes', () => {
    it('returns and persists a safe parse-failure audit side effect', async () => {
      const adapter = new InAppVoiceAdapter({
        store,
        gateway: scriptedGateway(['malformed sensitive classifier output']),
        proposalRepo,
        auditRepo,
        onCallRepo,
      });
      const { sessionId } = await adapter.startSession(TENANT, USER);

      const result = await adapter.handleInput(
        sessionId,
        'private customer transcript',
      );

      const failure = result.sideEffects.find(
        (effect) => effect.payload.eventType === 'classifier_parse_failure',
      );
      expect(failure?.payload).toEqual({
        eventType: 'classifier_parse_failure',
        failureClass: 'parse_failed',
      });
      const audit = auditRepo.getAll().find(
        (event) => event.eventType === 'classifier_parse_failure',
      );
      expect(audit?.metadata).toEqual(failure?.payload);
      expect(JSON.stringify({ failure, audit })).not.toContain('private customer transcript');
      expect(JSON.stringify({ failure, audit })).not.toContain('malformed sensitive');
    });

    it.each([
      ['deadline', 'DEADLINE_EXCEEDED', 'classifier_deadline_failure', 'deadline'],
      [
        'concurrency quota',
        'TENANT_CONCURRENCY_EXCEEDED',
        'classifier_quota_failure',
        'quota',
      ],
      [
        'token quota',
        'TENANT_TOKEN_BUDGET_EXCEEDED',
        'classifier_quota_failure',
        'quota',
      ],
    ])(
      'returns and persists a safe %s audit side effect',
      async (_label, code, eventType, failureClass) => {
        const adapter = new InAppVoiceAdapter({
          store,
          gateway: throwingGateway(code),
          proposalRepo,
          auditRepo,
          onCallRepo,
        });
        const { sessionId } = await adapter.startSession(TENANT, USER);

        const result = await adapter.handleInput(
          sessionId,
          'private customer transcript',
        );

        const failure = result.sideEffects.find(
          (effect) => effect.payload.eventType === eventType,
        );
        expect(failure?.payload).toEqual({
          eventType,
          failureClass,
          errorCode: code,
        });
        const audit = auditRepo.getAll().find((event) => event.eventType === eventType);
        expect(audit?.metadata).toEqual(failure?.payload);
        expect(JSON.stringify({ failure, audit })).not.toContain('private customer transcript');
        expect(JSON.stringify({ failure, audit })).not.toContain('sensitive provider detail');
      },
    );

    it('uses a provider fallback class without exposing unknown error details', async () => {
      const adapter = new InAppVoiceAdapter({
        store,
        gateway: throwingGateway('UNSAFE_PROVIDER_DETAIL'),
        proposalRepo,
        auditRepo,
        onCallRepo,
      });
      const { sessionId } = await adapter.startSession(TENANT, USER);

      const result = await adapter.handleInput(
        sessionId,
        'private customer transcript',
      );

      const failure = result.sideEffects.find(
        (effect) => effect.payload.eventType === 'classifier_provider_failure',
      );
      expect(failure?.payload).toEqual({
        eventType: 'classifier_provider_failure',
        failureClass: 'provider',
      });
      const audit = auditRepo.getAll().find(
        (event) => event.eventType === 'classifier_provider_failure',
      );
      expect(audit?.metadata).toEqual(failure?.payload);
      expect(JSON.stringify({ failure, audit })).not.toContain('private customer transcript');
      expect(JSON.stringify({ failure, audit })).not.toContain('sensitive provider detail');
      expect(JSON.stringify({ failure, audit })).not.toContain('UNSAFE_PROVIDER_DETAIL');
    });

    it('maps LLM_PROVIDER_UNAVAILABLE (breaker cascade) to provider, not deadline', async () => {
      const gateway = {
        complete: vi.fn(async () => {
          const error = new Error(
            'All providers failed. Last error: Request was aborted.',
          );
          Object.assign(error, { code: 'LLM_PROVIDER_UNAVAILABLE' });
          throw error;
        }),
      } as unknown as LLMGateway;
      const adapter = new InAppVoiceAdapter({
        store,
        gateway,
        proposalRepo,
        auditRepo,
        onCallRepo,
      });
      const { sessionId } = await adapter.startSession(TENANT, USER);
      const result = await adapter.handleInput(sessionId, 'schedule a visit');
      const failure = result.sideEffects.find(
        (effect) => effect.payload.eventType === 'classifier_provider_failure',
      );
      expect(failure?.payload).toEqual({
        eventType: 'classifier_provider_failure',
        failureClass: 'provider',
        errorCode: 'LLM_PROVIDER_UNAVAILABLE',
      });
      // FM-06: do not adapter-retry breaker/failover exhaustion.
      expect(gateway.complete).toHaveBeenCalledTimes(1);
    });

    it('maps Request-was-aborted to classifier_deadline_failure (not provider)', async () => {
      const gateway = {
        complete: vi.fn(async () => {
          throw new Error('Request was aborted.');
        }),
      } as unknown as LLMGateway;
      const adapter = new InAppVoiceAdapter({
        store,
        gateway,
        proposalRepo,
        auditRepo,
        onCallRepo,
        repairTemplatesResolver: async () => [
          {
            trigger: 'low_intent_confidence',
            text: 'Is this about scheduling a visit, or is something not working right now?',
          },
          {
            trigger: 'low_audio_confidence',
            text: "I'm having trouble hearing you — could you say that one more time?",
          },
        ],
      });
      const { sessionId } = await adapter.startSession(TENANT, USER);

      const result = await adapter.handleInput(sessionId, 'schedule a visit for tomorrow');

      const failure = result.sideEffects.find(
        (effect) => effect.payload.eventType === 'classifier_deadline_failure',
      );
      expect(failure?.payload).toEqual({
        eventType: 'classifier_deadline_failure',
        failureClass: 'deadline',
        errorCode: 'DEADLINE_EXCEEDED',
      });
      expect(result.ttsText ?? '').toContain('scheduling a visit');
      expect(result.ttsText ?? '').not.toContain('trouble hearing');
    });
  });

  it('emergency_dispatch fast-paths to escalating', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'emergency_dispatch',
        confidence: 0.97,
        extractedEntities: {},
      }),
    ]);
    onCallRepo = new InMemoryOnCallRepository(
      new Map([[TENANT, [{ id: 'r1', userId: 'dispatcher-1', orderIndex: 0 }]]])
    );
    const adapter = new InAppVoiceAdapter({
      store,
      gateway,
      proposalRepo,
      auditRepo,
      onCallRepo,
    });
    const { sessionId } = await adapter.startSession(TENANT, USER);
    const result = await adapter.handleInput(sessionId, 'gas smell from the furnace');
    expect(result.state).toBe('escalating');
    // notifyOncall side-effect should have been emitted
    const escalatingEffect = result.sideEffects.find((e) => e.type === 'notify_oncall');
    expect(escalatingEffect).toBeDefined();
  });

  it('endSession marks the session ended and removes from store', async () => {
    const gateway = scriptedGateway([]);
    const adapter = new InAppVoiceAdapter({
      store,
      gateway,
      proposalRepo,
      auditRepo,
      onCallRepo,
    });
    const { sessionId } = await adapter.startSession(TENANT, USER);
    await adapter.endSession(sessionId);
    expect(store.peek(sessionId)).toBeUndefined();
  });

  it('handleInput throws if session not found', async () => {
    const gateway = scriptedGateway([]);
    const adapter = new InAppVoiceAdapter({
      store,
      gateway,
      proposalRepo,
      auditRepo,
      onCallRepo,
    });
    await expect(adapter.handleInput('does-not-exist', 'hi')).rejects.toThrow(/not found/i);
  });

  describe('§3B verticalPromptResolver wire-up', () => {
    it('passes the resolved vertical section through to classifyIntent', async () => {
      const gateway = scriptedGateway([
        JSON.stringify({ intentType: 'create_invoice', confidence: 0.92 }),
      ]);
      const verticalPromptResolver = vi.fn(async (tenantId: string) => {
        expect(tenantId).toBe(TENANT);
        return 'Service vertical: HVAC Professional\nEquipment: Furnace (heater)';
      });
      const adapter = new InAppVoiceAdapter({
        store,
        gateway,
        proposalRepo,
        auditRepo,
        onCallRepo,
        verticalPromptResolver,
      });
      const { sessionId } = await adapter.startSession(TENANT, USER);
      await adapter.handleInput(sessionId, 'invoice Acme');

      expect(verticalPromptResolver).toHaveBeenCalledWith(TENANT);
      const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMessages = call.messages.filter((m: { role: string }) => m.role === 'system');
      expect(systemMessages).toHaveLength(2);
      expect(systemMessages[1].content).toContain('Service vertical: HVAC Professional');
    });

    it('falls back to base prompt when resolver throws', async () => {
      const gateway = scriptedGateway([
        JSON.stringify({ intentType: 'create_invoice', confidence: 0.92 }),
      ]);
      const verticalPromptResolver = vi.fn(async () => {
        throw new Error('pack lookup blew up');
      });
      const adapter = new InAppVoiceAdapter({
        store,
        gateway,
        proposalRepo,
        auditRepo,
        onCallRepo,
        verticalPromptResolver,
      });
      const { sessionId } = await adapter.startSession(TENANT, USER);
      // Must not throw — turn proceeds without the vertical context.
      await expect(adapter.handleInput(sessionId, 'invoice Acme')).resolves.toBeDefined();
      const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMessages = call.messages.filter((m: { role: string }) => m.role === 'system');
      expect(systemMessages).toHaveLength(1);
    });

    it('omits the vertical message when resolver returns undefined', async () => {
      const gateway = scriptedGateway([
        JSON.stringify({ intentType: 'create_invoice', confidence: 0.92 }),
      ]);
      const verticalPromptResolver = vi.fn(async () => undefined);
      const adapter = new InAppVoiceAdapter({
        store,
        gateway,
        proposalRepo,
        auditRepo,
        onCallRepo,
        verticalPromptResolver,
      });
      const { sessionId } = await adapter.startSession(TENANT, USER);
      await adapter.handleInput(sessionId, 'invoice Acme');

      const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMessages = call.messages.filter((m: { role: string }) => m.role === 'system');
      expect(systemMessages).toHaveLength(1);
    });
  });

  describe('§3C callerPlanResolver wire-up', () => {
    it('does not call the plan resolver when the caller is not yet identified', async () => {
      const gateway = scriptedGateway([
        JSON.stringify({ intentType: 'create_invoice', confidence: 0.92 }),
      ]);
      const callerPlanResolver = vi.fn(async () => 'should not be used');
      const adapter = new InAppVoiceAdapter({
        store,
        gateway,
        proposalRepo,
        auditRepo,
        onCallRepo,
        callerPlanResolver,
      });
      const { sessionId } = await adapter.startSession(TENANT, USER);
      await adapter.handleInput(sessionId, 'invoice Acme');

      expect(callerPlanResolver).not.toHaveBeenCalled();
    });

    it('passes the plan section through to classifyIntent when caller is identified', async () => {
      const gateway = scriptedGateway([
        JSON.stringify({ intentType: 'create_appointment', confidence: 0.9 }),
      ]);
      const callerPlanResolver = vi.fn(
        async (_tenantId: string, _customerId: string) =>
          'Caller is on an active maintenance plan.\nPlans: Gold Membership',
      );
      const adapter = new InAppVoiceAdapter({
        store,
        gateway,
        proposalRepo,
        auditRepo,
        onCallRepo,
        callerPlanResolver,
      });
      const { sessionId } = await adapter.startSession(TENANT, USER);

      // Simulate identifyCaller having attached a customerId to the session.
      const session = store.peek(sessionId);
      if (!session) throw new Error('test session missing');
      session.customerId = 'cust-1';

      await adapter.handleInput(sessionId, 'when is my next visit');
      expect(callerPlanResolver).toHaveBeenCalledWith(TENANT, 'cust-1');
      const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMessages = call.messages.filter((m: { role: string }) => m.role === 'system');
      // Base prompt + plan section = 2 system messages (no vertical
      // resolver wired in this test).
      expect(systemMessages).toHaveLength(2);
      expect(systemMessages[1].content).toContain('Caller plan context');
      expect(systemMessages[1].content).toContain('Gold Membership');
    });

    it('PR B — passes resolved tenant threshold override through to createProposal', async () => {
      const gateway = scriptedGateway([
        JSON.stringify({
          intentType: 'create_invoice',
          confidence: 0.94,
          extractedEntities: { customerName: 'Acme', amount: 45000 },
        }),
      ]);
      const thresholdResolver = vi.fn(async (tenantId: string) => {
        expect(tenantId).toBe(TENANT);
        return { supervisor: 0.85, both: 0.88, tech: 0.92 };
      });
      const adapter = new InAppVoiceAdapter({
        store,
        gateway,
        proposalRepo,
        auditRepo,
        onCallRepo,
        thresholdResolver,
      });
      const { sessionId } = await adapter.startSession(TENANT, USER);
      await adapter.handleInput(sessionId, 'Invoice Acme for 450');
      // Caller confirms the readback so the proposal is actually created.
      await adapter.handleInput(sessionId, 'yes');
      expect(thresholdResolver).toHaveBeenCalledWith(TENANT);
      // Without going through the full proposal-status decision, the
      // smoke test is: the resolver was called and a proposal was
      // persisted. Behavior coverage of the auto-approve threshold
      // decision lives in proposals/auto-approve tests.
      const proposals = await proposalRepo.findByTenant(TENANT);
      expect(proposals.length).toBe(1);
    });

    it('PR B — degrades gracefully when the threshold resolver throws', async () => {
      const gateway = scriptedGateway([
        JSON.stringify({ intentType: 'create_invoice', confidence: 0.94 }),
      ]);
      const thresholdResolver = vi.fn(async () => {
        throw new Error('simulated DB outage');
      });
      const adapter = new InAppVoiceAdapter({
        store,
        gateway,
        proposalRepo,
        auditRepo,
        onCallRepo,
        thresholdResolver,
      });
      const { sessionId } = await adapter.startSession(TENANT, USER);
      // Must not throw — falls through to DEFAULT_AUTO_APPROVE_THRESHOLDS.
      await expect(adapter.handleInput(sessionId, 'Invoice Acme')).resolves.toBeDefined();
    });

    it('falls back gracefully when the plan resolver throws', async () => {
      const gateway = scriptedGateway([
        JSON.stringify({ intentType: 'create_invoice', confidence: 0.92 }),
      ]);
      const callerPlanResolver = vi.fn(async () => {
        throw new Error('agreement repo blew up');
      });
      const adapter = new InAppVoiceAdapter({
        store,
        gateway,
        proposalRepo,
        auditRepo,
        onCallRepo,
        callerPlanResolver,
      });
      const { sessionId } = await adapter.startSession(TENANT, USER);
      const session = store.peek(sessionId);
      if (!session) throw new Error('test session missing');
      session.customerId = 'cust-1';

      await expect(adapter.handleInput(sessionId, 'invoice Acme')).resolves.toBeDefined();
      const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMessages = call.messages.filter((m: { role: string }) => m.role === 'system');
      expect(systemMessages).toHaveLength(1);
    });
  });

  describe('B2 — voiceSessionRepo outcome stamping', () => {
    it('inserts a voice_sessions row on startSession with channel=inapp_voice', async () => {
      const gateway = scriptedGateway([]);
      const voiceSessionRepo = new InMemoryVoiceSessionRepository();
      const adapter = new InAppVoiceAdapter({
        store,
        gateway,
        proposalRepo,
        auditRepo,
        onCallRepo,
        voiceSessionRepo,
      });
      const { sessionId } = await adapter.startSession(TENANT, USER);
      // Microtask flush — fire-and-forget create.
      await Promise.resolve();
      const row = await voiceSessionRepo.findById(TENANT, sessionId);
      expect(row).not.toBeNull();
      expect(row?.channel).toBe('inapp_voice');
      expect(row?.callSid).toBeUndefined();
      expect(row?.outcome).toBeUndefined();
    });

    it('stamps outcome=no_intent on endSession when caller spoke but no intent crossed TAU_INT', async () => {
      const gateway = scriptedGateway([
        JSON.stringify({ intentType: 'unknown', confidence: 0.2 }),
      ]);
      const voiceSessionRepo = new InMemoryVoiceSessionRepository();
      const adapter = new InAppVoiceAdapter({
        store,
        gateway,
        proposalRepo,
        auditRepo,
        onCallRepo,
        voiceSessionRepo,
      });
      const { sessionId } = await adapter.startSession(TENANT, USER);
      await adapter.handleInput(sessionId, 'umm uh');
      await adapter.endSession(sessionId);
      // persistSessionEnded is fire-and-forget; flush microtasks so the
      // InMemory repo write completes before we assert on it.
      await Promise.resolve();
      await Promise.resolve();
      const row = await voiceSessionRepo.findById(TENANT, sessionId);
      expect(row?.outcome).toBe('no_intent');
      expect(row?.endedReason).toBe('session_ended');
      expect(row?.endedAt).toBeInstanceOf(Date);
      // session_ended is ignored from intent_capture so the FSM stays
      // in intent_capture; the column reflects whatever final state the
      // FSM actually reached at finalize time (no synthetic terminated).
      expect(row?.state).toBe('intent_capture');
    });

    it('stamps outcome=completed on endSession after a proposal queued', async () => {
      const gateway = scriptedGateway([
        JSON.stringify({
          intentType: 'create_invoice',
          confidence: 0.94,
          extractedEntities: { customerName: 'Acme', amount: 45000 },
        }),
      ]);
      const voiceSessionRepo = new InMemoryVoiceSessionRepository();
      const adapter = new InAppVoiceAdapter({
        store,
        gateway,
        proposalRepo,
        auditRepo,
        onCallRepo,
        voiceSessionRepo,
      });
      const { sessionId } = await adapter.startSession(TENANT, USER);
      await adapter.handleInput(sessionId, 'Invoice Acme for 450');
      // Caller confirms the readback → proposal queued → closing.
      await adapter.handleInput(sessionId, 'yes');
      await adapter.endSession(sessionId);
      await Promise.resolve();
      await Promise.resolve();
      const row = await voiceSessionRepo.findById(TENANT, sessionId);
      expect(row?.outcome).toBe('completed');
    });

    it('endSession works without voiceSessionRepo (legacy fixtures stay green)', async () => {
      const gateway = scriptedGateway([]);
      const adapter = new InAppVoiceAdapter({
        store,
        gateway,
        proposalRepo,
        auditRepo,
        onCallRepo,
      });
      const { sessionId } = await adapter.startSession(TENANT, USER);
      await expect(adapter.endSession(sessionId)).resolves.toBeUndefined();
    });

    it('finalizes outcome on FSM end_session mid-turn without DELETE call', async () => {
      // abuse_detected emits end_session and lands the FSM in
      // 'terminated' inside a single handleInput. The client may
      // observe `ended: true` and never call DELETE — the outcome
      // must still be stamped, with the FSM-supplied reason
      // (abuse_detected:*) preserved so the mapper returns
      // escalated_to_human, not a generic session_ended outcome.
      const gateway = scriptedGateway([]);
      const voiceSessionRepo = new InMemoryVoiceSessionRepository();
      const adapter = new InAppVoiceAdapter({
        store,
        gateway,
        proposalRepo,
        auditRepo,
        onCallRepo,
        voiceSessionRepo,
      });
      const { sessionId } = await adapter.startSession(TENANT, USER);
      // Drive an abuse_detected event directly on the FSM, then run an
      // input turn so executeSideEffects observes the end_session.
      const session = store.peek(sessionId);
      if (!session) throw new Error('test session missing');
      const effects = session.machine.dispatch({ type: 'abuse_detected', category: 'profanity' });
      await (
        adapter as unknown as {
          executeSideEffects: (s: typeof session, e: typeof effects) => Promise<unknown>;
        }
      ).executeSideEffects(session, effects);
      // Replicate _handleInputLocked's end-of-turn finalize block by
      // calling handleInput with a no-op turn — the FSM is already in
      // 'terminated', and handleInput's endedNow branch should fire.
      // (Direct invocation here avoids re-driving the classifier.)
      // The abuse_detected event already set machine.currentState to
      // 'terminated', so endedNow=true and finalizeTerminalOutcome runs.
      await (
        adapter as unknown as {
          finalizeTerminalOutcome: (
            s: typeof session,
            r: string,
          ) => void;
        }
      ).finalizeTerminalOutcome(session, 'abuse_detected:profanity');
      await Promise.resolve();
      await Promise.resolve();
      const row = await voiceSessionRepo.findById(TENANT, sessionId);
      expect(row?.outcome).toBe('escalated_to_human');
      expect(row?.endedReason).toBe('abuse_detected:profanity');
    });

    it('repo.create() failure is non-fatal', async () => {
      const gateway = scriptedGateway([]);
      const voiceSessionRepo: InMemoryVoiceSessionRepository = new InMemoryVoiceSessionRepository();
      voiceSessionRepo.create = vi.fn(async () => {
        throw new Error('boom');
      }) as typeof voiceSessionRepo.create;
      const adapter = new InAppVoiceAdapter({
        store,
        gateway,
        proposalRepo,
        auditRepo,
        onCallRepo,
        voiceSessionRepo,
      });
      await expect(adapter.startSession(TENANT, USER)).resolves.toBeDefined();
    });
  });
});

describe('QA-2026-07-26 — voice-drafted estimate line items (lineItemDescriptions)', () => {
  let store: VoiceSessionStore;
  let proposalRepo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;
  let onCallRepo: InMemoryOnCallRepository;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
    proposalRepo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
    onCallRepo = new InMemoryOnCallRepository();
  });

  afterEach(() => {
    store.dispose();
  });

  function buildAdapter(catalogRepo?: InMemoryCatalogItemRepository): InAppVoiceAdapter {
    return new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway([]),
      proposalRepo,
      auditRepo,
      onCallRepo,
      ...(catalogRepo ? { catalogRepo } : {}),
    });
  }

  function callBuildVoiceDraftLineItems(
    adapter: InAppVoiceAdapter,
    tenantId: string,
    descriptions: string[],
    amount: unknown,
  ): Promise<CatalogPricingOutcome> {
    return (
      adapter as unknown as {
        buildVoiceDraftLineItems: (
          t: string,
          d: string[],
          a: unknown,
        ) => Promise<CatalogPricingOutcome>;
      }
    ).buildVoiceDraftLineItems(tenantId, descriptions, amount);
  }

  function callHandleCreateProposal(
    adapter: InAppVoiceAdapter,
    session: VoiceSession,
    effect: SideEffect,
  ): Promise<string | undefined> {
    return (
      adapter as unknown as {
        handleCreateProposal: (s: VoiceSession, e: SideEffect) => Promise<string | undefined>;
      }
    ).handleCreateProposal(session, effect);
  }

  describe('buildVoiceDraftLineItems (unit)', () => {
    it('single description + amount produces one correctly-priced item', async () => {
      const outcome = await callBuildVoiceDraftLineItems(
        buildAdapter(),
        TENANT,
        ['diagnostic labor'],
        15000,
      );
      expect(outcome.lineItems).toHaveLength(1);
      expect(outcome.lineItems[0].description).toBe('diagnostic labor');
      expect(outcome.lineItems[0].quantity).toBe(1);
      expect(outcome.lineItems[0].unitPrice).toBe(15000);
      // No catalog wired — kept as the caller-quoted price but flagged for
      // review rather than trusted outright.
      expect(outcome.lineItems[0].pricingSource).toBe('uncatalogued');
      expect(outcome.requiresReview).toBe(true);
    });

    it('multiple descriptions + amount evenly splits the total across lines', async () => {
      const outcome = await callBuildVoiceDraftLineItems(
        buildAdapter(),
        TENANT,
        ['diagnostic labor', 'replacement filter', 'disposal fee'],
        30000,
      );
      expect(outcome.lineItems).toHaveLength(3);
      const prices = outcome.lineItems.map((li) => li.unitPrice as number);
      expect(prices).toEqual([10000, 10000, 10000]);
      expect(prices.reduce((a, b) => a + b, 0)).toBe(30000);
    });

    it('an uneven split folds the remainder into the last line so the sum matches the quoted total exactly', async () => {
      const outcome = await callBuildVoiceDraftLineItems(
        buildAdapter(),
        TENANT,
        ['line a', 'line b', 'line c'],
        10000,
      );
      const prices = outcome.lineItems.map((li) => li.unitPrice as number);
      expect(prices.reduce((a, b) => a + b, 0)).toBe(10000);
      expect(prices[0]).toBe(3333);
      expect(prices[1]).toBe(3333);
      expect(prices[2]).toBe(3334);
    });

    it('a description with a catalog match uses the catalog price and does not force review', async () => {
      const catalogRepo = new InMemoryCatalogItemRepository();
      await catalogRepo.create(
        createCatalogItem({
          tenantId: TENANT,
          name: 'Diagnostic Labor',
          category: 'Labor',
          unit: 'each',
          unitPriceCents: 15000,
        }),
      );
      // No amount quoted at all — the catalog is the sole source of truth
      // and should still price the line (see catalog-resolver.ts: a
      // missing drafted price never trips the price-conflict check).
      const outcome = await callBuildVoiceDraftLineItems(
        buildAdapter(catalogRepo),
        TENANT,
        ['diagnostic labor'],
        undefined,
      );
      expect(outcome.lineItems).toHaveLength(1);
      expect(outcome.lineItems[0].unitPrice).toBe(15000);
      expect(outcome.lineItems[0].pricingSource).toBe('catalog');
      expect(outcome.anyUncatalogued).toBe(false);
      expect(outcome.requiresReview).toBe(false);
    });

    it('a description with no catalog match keeps the guessed price but forces review', async () => {
      const catalogRepo = new InMemoryCatalogItemRepository();
      await catalogRepo.create(
        createCatalogItem({
          tenantId: TENANT,
          name: 'Water Heater Install',
          category: 'Labor',
          unit: 'each',
          unitPriceCents: 90000,
        }),
      );
      const outcome = await callBuildVoiceDraftLineItems(
        buildAdapter(catalogRepo),
        TENANT,
        ['exotic bespoke widget calibration'],
        15000,
      );
      expect(outcome.lineItems).toHaveLength(1);
      expect(outcome.lineItems[0].unitPrice).toBe(15000);
      expect(outcome.lineItems[0].pricingSource).toBe('uncatalogued');
      expect(outcome.anyUncatalogued).toBe(true);
      expect(outcome.requiresReview).toBe(true);
    });

    it('no amount and no catalog leaves the line unpriced rather than inventing a number', async () => {
      // groundLineItemPricing's markAllUncatalogued (catalog-resolver.ts)
      // only stamps `uncatalogued`/requiresReview for lines that DO carry a
      // numeric drafted price — "a line with no numeric price carries no
      // money risk and is left untouched" (its own doc comment), since the
      // execution handler's normalizeDraftLineItems (handlers.ts) reports a
      // truly priceless line as malformed at approval time rather than
      // letting it through silently. Confirm that's exactly what happens
      // here: no fabricated number, and the execution handler surfaces an
      // actionable "no usable unit price" error instead of the old opaque
      // "must include at least one lineItem".
      const outcome = await callBuildVoiceDraftLineItems(
        buildAdapter(),
        TENANT,
        ['exotic bespoke widget calibration'],
        undefined,
      );
      expect(outcome.lineItems).toHaveLength(1);
      expect(outcome.lineItems[0].unitPrice).toBeUndefined();
      expect(outcome.requiresReview).toBe(false);

      const { normalizeDraftLineItems } = await import(
        '../../../../src/proposals/execution/handlers'
      );
      const { malformed } = normalizeDraftLineItems(outcome.lineItems);
      expect(malformed).toHaveLength(1);
      expect(malformed[0]).toContain('no usable unit price');
    });
  });

  describe('handleCreateProposal integration (regression for "Payload must include at least one lineItem")', () => {
    it('a draft_estimate create_proposal effect with lineItemDescriptions produces a payload that DraftEstimateExecutionHandler executes successfully', async () => {
      const catalogRepo = new InMemoryCatalogItemRepository();
      await catalogRepo.create(
        createCatalogItem({
          tenantId: TENANT,
          name: 'Diagnostic Labor',
          category: 'Labor',
          unit: 'each',
          unitPriceCents: 15000,
        }),
      );
      const adapter = buildAdapter(catalogRepo);
      const { sessionId } = await adapter.startSession(TENANT, USER);
      const session = store.peek(sessionId);
      if (!session) throw new Error('test session missing');

      const proposalId = await callHandleCreateProposal(adapter, session, {
        type: 'create_proposal',
        payload: {
          tenantId: TENANT,
          intent: 'draft_estimate',
          entities: {
            customerId: 'cust-1',
            lineItemDescriptions: ['diagnostic labor'],
            amount: 15000,
          },
          sessionId: session.id,
          confidence: 0.95,
        },
      });

      expect(proposalId).toBeDefined();
      const proposals = await proposalRepo.findByTenant(TENANT);
      expect(proposals).toHaveLength(1);
      const proposal = proposals[0];
      expect(proposal.proposalType).toBe('draft_estimate');
      expect(Array.isArray(proposal.payload.lineItems)).toBe(true);
      expect((proposal.payload.lineItems as unknown[]).length).toBe(1);

      // BEFORE this fix, payload.lineItems was always undefined here and
      // execution failed with "Payload must include at least one lineItem."
      const handler = new DraftEstimateExecutionHandler();
      const result = await handler.execute(proposal, {
        tenantId: TENANT,
        executedBy: 'operator-1',
      });
      expect(result.success).toBe(true);
    });

    it('forces the proposal out of auto-approval when a drafted line has no catalog match, even at high classifier confidence', async () => {
      const adapter = buildAdapter(); // no catalogRepo — every line is uncatalogued
      const { sessionId } = await adapter.startSession(TENANT, USER);
      const session = store.peek(sessionId);
      if (!session) throw new Error('test session missing');

      await callHandleCreateProposal(adapter, session, {
        type: 'create_proposal',
        payload: {
          tenantId: TENANT,
          intent: 'draft_estimate',
          entities: {
            customerId: 'cust-1',
            lineItemDescriptions: ['diagnostic labor'],
            amount: 15000,
          },
          sessionId: session.id,
          // High confidence would normally auto-approve a capture-class
          // proposal — must be blocked by the uncatalogued price cap.
          confidence: 0.99,
        },
      });

      const proposals = await proposalRepo.findByTenant(TENANT);
      expect(proposals).toHaveLength(1);
      expect(proposals[0].status).not.toBe('approved');
      expect(proposals[0].confidenceScore).toBeLessThanOrEqual(0.85);
    });

    // QA-2026-07-26 VOX-06: the classifier only emits `sendChannel`, the
    // send_* task contracts read `channel`. The flat-promotion loop copies
    // entity keys verbatim, so the persisted payload had sendChannel and no
    // channel — "send estimate EST-0033 to the customer by email" classified,
    // resolved and got approved, then failed execution with "Payload must
    // specify channel as email or sms". The alias mirrors the non-voice
    // path's `channel: ee.sendChannel ?? 'email'` (voice-extended-tasks.ts).
    it('a send_estimate create_proposal effect promotes entities.sendChannel to payload.channel so SendEstimateExecutionHandler executes successfully', async () => {
      const estimateUuid = '550e8400-e29b-41d4-a716-446655440000';
      const adapter = buildAdapter();
      const { sessionId } = await adapter.startSession(TENANT, USER);
      const session = store.peek(sessionId);
      if (!session) throw new Error('test session missing');

      const proposalId = await callHandleCreateProposal(adapter, session, {
        type: 'create_proposal',
        payload: {
          tenantId: TENANT,
          intent: 'send_estimate',
          entities: {
            estimateId: estimateUuid,
            estimateReference: 'EST-0033',
            sendChannel: 'email',
          },
          sessionId: session.id,
          confidence: 0.9,
        },
      });

      expect(proposalId).toBeDefined();
      const proposals = await proposalRepo.findByTenant(TENANT);
      expect(proposals).toHaveLength(1);
      const proposal = proposals[0];
      expect(proposal.proposalType).toBe('send_estimate');
      // BEFORE this fix payload.channel was undefined here.
      expect(proposal.payload.channel).toBe('email');
      // The raw classifier key is still carried for audit/rendering.
      expect(proposal.payload.sendChannel).toBe('email');

      const provider = new NoopEstimateDeliveryProvider();
      const result = await new SendEstimateExecutionHandler(provider).execute(proposal, {
        tenantId: TENANT,
        executedBy: 'operator-1',
      });
      expect(result.success).toBe(true);
      expect(provider.lastDispatch?.channel).toBe('email');
    });

    it('a send_estimate effect with sendChannel=sms promotes sms, not a hardcoded email default', async () => {
      const estimateUuid = '550e8400-e29b-41d4-a716-446655440000';
      const adapter = buildAdapter();
      const { sessionId } = await adapter.startSession(TENANT, USER);
      const session = store.peek(sessionId);
      if (!session) throw new Error('test session missing');

      await callHandleCreateProposal(adapter, session, {
        type: 'create_proposal',
        payload: {
          tenantId: TENANT,
          intent: 'send_estimate',
          entities: { estimateId: estimateUuid, sendChannel: 'sms' },
          sessionId: session.id,
          confidence: 0.9,
        },
      });

      const proposals = await proposalRepo.findByTenant(TENANT);
      expect(proposals[0].payload.channel).toBe('sms');
    });
  });
});

describe('QA-2026-07-26 — session-start callerPhone resolution', () => {
  let store: VoiceSessionStore;
  let proposalRepo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;
  let onCallRepo: InMemoryOnCallRepository;
  let customerRepo: InMemoryCustomerRepository;

  const CALLER_PHONE = '+15551234567';

  function fixtureCustomer(overrides: Partial<Customer> = {}): Customer {
    const now = new Date();
    return {
      id: 'cust-phone-1',
      tenantId: TENANT,
      firstName: 'Jane',
      lastName: 'Doe',
      displayName: 'Jane Doe',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      primaryPhone: CALLER_PHONE,
      createdBy: 'system',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
    proposalRepo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
    onCallRepo = new InMemoryOnCallRepository();
    customerRepo = new InMemoryCustomerRepository();
  });

  afterEach(() => store.dispose());

  it('1-match: resolves the caller to the matching customer and seeds context.customerId via caller_known', async () => {
    await customerRepo.create(fixtureCustomer());
    const adapter = new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway([]),
      proposalRepo,
      auditRepo,
      onCallRepo,
      customerRepo,
    });
    const { sessionId } = await adapter.startSession(TENANT, USER, undefined, undefined, CALLER_PHONE);
    const session = store.peek(sessionId);
    expect(session?.customerId).toBe('cust-phone-1');
    expect(session?.machine.currentContext.customerId).toBe('cust-phone-1');
  });

  it('0-match: leaves the caller unresolved and falls back to operator_session (unchanged)', async () => {
    const adapter = new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway([]),
      proposalRepo,
      auditRepo,
      onCallRepo,
      customerRepo,
    });
    const { sessionId } = await adapter.startSession(TENANT, USER, undefined, undefined, '+15559999999');
    const session = store.peek(sessionId);
    expect(session?.customerId).toBeUndefined();
    expect(session?.machine.currentContext.customerId).toBeUndefined();
  });

  it('2+-match: never guesses — leaves the caller unresolved when the phone matches more than one customer', async () => {
    await customerRepo.create(fixtureCustomer({ id: 'cust-phone-1' }));
    await customerRepo.create(fixtureCustomer({ id: 'cust-phone-2' }));
    const adapter = new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway([]),
      proposalRepo,
      auditRepo,
      onCallRepo,
      customerRepo,
    });
    const { sessionId } = await adapter.startSession(TENANT, USER, undefined, undefined, CALLER_PHONE);
    const session = store.peek(sessionId);
    expect(session?.customerId).toBeUndefined();
    expect(session?.machine.currentContext.customerId).toBeUndefined();
  });

  it('no callerPhone provided: unchanged operator_session path even when customerRepo is wired', async () => {
    await customerRepo.create(fixtureCustomer());
    const adapter = new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway([]),
      proposalRepo,
      auditRepo,
      onCallRepo,
      customerRepo,
    });
    const { sessionId } = await adapter.startSession(TENANT, USER);
    const session = store.peek(sessionId);
    expect(session?.customerId).toBeUndefined();
    expect(session?.machine.currentContext.customerId).toBeUndefined();
  });

  it('end-to-end: a generic "our customer" reference in a create_invoice turn resolves to the phone-matched customerId', async () => {
    await customerRepo.create(fixtureCustomer());
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'create_invoice',
        confidence: 0.94,
        extractedEntities: { customerName: 'our customer', amount: 45000 },
      }),
    ]);
    const adapter = new InAppVoiceAdapter({
      store,
      gateway,
      proposalRepo,
      auditRepo,
      onCallRepo,
      customerRepo,
    });
    const { sessionId } = await adapter.startSession(TENANT, USER, undefined, undefined, CALLER_PHONE);
    const readback = await adapter.handleInput(sessionId, 'invoice our customer for 450');
    expect(readback.state).toBe('intent_confirm');
    const result = await adapter.handleInput(sessionId, 'yes');
    expect(result.state).toBe('closing');
    expect(result.proposalIds).toHaveLength(1);
    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].payload.customerId).toBe('cust-phone-1');
    expect((proposals[0].payload.entities as Record<string, unknown>).customerId).toBe('cust-phone-1');
  });

  it('ordering: a MORE SPECIFIC customer resolved this turn wins over the generic phone-matched fallback', async () => {
    await customerRepo.create(fixtureCustomer({ id: 'cust-phone-1' }));
    const namedResolver: EntityResolver = {
      resolve: vi.fn(async () => ({
        kind: 'resolved' as const,
        candidate: { id: 'cust-named-2', kind: 'customer' as const, label: 'Bob Smith', score: 0.95 },
      })),
    };
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'create_invoice',
        confidence: 0.94,
        extractedEntities: { customerName: 'Bob Smith', amount: 45000 },
      }),
    ]);
    const adapter = new InAppVoiceAdapter({
      store,
      gateway,
      proposalRepo,
      auditRepo,
      onCallRepo,
      customerRepo,
      entityResolver: namedResolver,
    });
    const { sessionId } = await adapter.startSession(TENANT, USER, undefined, undefined, CALLER_PHONE);
    // Sanity: the phone-matched fallback IS on the session/context.
    expect(store.peek(sessionId)?.customerId).toBe('cust-phone-1');
    const readback = await adapter.handleInput(sessionId, 'invoice Bob Smith for 450');
    expect(readback.state).toBe('intent_confirm');
    const result = await adapter.handleInput(sessionId, 'yes');
    expect(result.state).toBe('closing');
    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    // The specifically-resolved customer wins, NOT the phone-matched fallback.
    expect(proposals[0].payload.customerId).toBe('cust-named-2');
    expect((proposals[0].payload.entities as Record<string, unknown>).customerId).toBe('cust-named-2');
  });
});

describe('InAppVoiceAdapter#toResolutionEvent', () => {
  let store: VoiceSessionStore;
  let proposalRepo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;
  let onCallRepo: InMemoryOnCallRepository;
  let adapter: InAppVoiceAdapter;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
    proposalRepo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
    onCallRepo = new InMemoryOnCallRepository();
    adapter = new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway([]),
      proposalRepo,
      auditRepo,
      onCallRepo,
    });
  });

  function toResolutionEvent(resolution: SchedulingEntityResolution): Promise<CallingAgentEvent> {
    return (
      adapter as unknown as {
        toResolutionEvent: (tenantId: string, r: SchedulingEntityResolution) => Promise<CallingAgentEvent>;
      }
    ).toResolutionEvent(TENANT, resolution);
  }

  it('resolved → entity_resolved carrying the accumulated refs', async () => {
    const event = await toResolutionEvent({
      status: 'resolved',
      refs: { customerId: 'cust-1' },
    });
    expect(event).toEqual({ type: 'entity_resolved', refs: { customerId: 'cust-1' } });
  });

  it('ambiguous → entity_ambiguous carrying candidates, refKey, and partialRefs', async () => {
    const event = await toResolutionEvent({
      status: 'ambiguous',
      refs: { customerId: 'cust-1' },
      ambiguous: {
        entityKind: 'job',
        reference: 'the HVAC job',
        candidates: [
          { id: 'job-1', kind: 'job', label: 'HVAC Repair', score: 0.9 },
          { id: 'job-2', kind: 'job', label: 'HVAC Install', score: 0.85 },
        ],
      },
    });
    expect(event.type).toBe('entity_ambiguous');
    if (event.type === 'entity_ambiguous') {
      expect(event.entityKind).toBe('job');
      expect(event.refKey).toBe('jobId');
      expect(event.reference).toBe('the HVAC job');
      expect(event.partialRefs).toEqual({ customerId: 'cust-1' });
      expect(event.candidates).toEqual([
        { id: 'job-1', name: 'HVAC Repair', score: 0.9, hint: undefined },
        { id: 'job-2', name: 'HVAC Install', score: 0.85, hint: undefined },
      ]);
    }
  });

  it('not_found → entity_not_found with no payload (Fix 1 regression guard)', async () => {
    const event = await toResolutionEvent({
      status: 'not_found',
      refs: {},
      notFound: { entityKind: 'job', reference: 'the QA Matrix job' },
    });
    expect(event).toEqual({ type: 'entity_not_found' });
  });

  it('low_confidence → entity_confirm_candidate carrying the candidate, refKey, and partialRefs', async () => {
    const event = await toResolutionEvent({
      status: 'low_confidence',
      refs: { customerId: 'cust-1' },
      lowConfidence: {
        entityKind: 'job',
        reference: 'the QA Matrix job',
        candidate: { id: 'job-9', kind: 'job', label: 'QA Matrix Repair', score: 0.7 },
      },
    });
    expect(event.type).toBe('entity_confirm_candidate');
    if (event.type === 'entity_confirm_candidate') {
      expect(event.entityKind).toBe('job');
      expect(event.refKey).toBe('jobId');
      expect(event.reference).toBe('the QA Matrix job');
      expect(event.partialRefs).toEqual({ customerId: 'cust-1' });
      expect(event.candidate).toEqual({ id: 'job-9', kind: 'job', label: 'QA Matrix Repair', score: 0.7 });
    }
  });
});
