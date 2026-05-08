import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InAppVoiceAdapter } from '../../../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../../../src/oncall/rotation';
import { InMemoryVoiceSessionRepository } from '../../../../src/voice/voice-session';
import type { LLMGateway, LLMResponse } from '../../../../src/ai/gateway/gateway';
import type { TtsProvider } from '../../../../src/ai/tts/tts-provider';

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
    const result = await adapter.handleInput(sessionId, 'Invoice Acme for 450');
    expect(result.proposalIds.length).toBe(1);
    expect(result.state).toBe('closing');
    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals.length).toBe(1);
    expect(proposals[0].proposalType).toBe('draft_invoice');
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
      const row = await voiceSessionRepo.findById(TENANT, sessionId);
      expect(row?.outcome).toBe('no_intent');
      expect(row?.endedReason).toBe('session_ended');
      expect(row?.endedAt).toBeInstanceOf(Date);
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
      await adapter.endSession(sessionId);
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
