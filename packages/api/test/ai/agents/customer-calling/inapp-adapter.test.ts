import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InAppVoiceAdapter } from '../../../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../../../src/oncall/rotation';
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
});
