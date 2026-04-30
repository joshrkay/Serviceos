/**
 * P8-009 — InAppVoiceAdapter tests
 *
 * Covers:
 *   - Full session lifecycle: start → input → confirm → end
 *   - identify_caller called in 'identifying' state
 *   - classifyIntent called in 'intent_capture' state
 *   - Side effects: tts_play → ttsProvider called, create_proposal → proposalRepo called
 *   - SSE clients notified on state change
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InAppVoiceAdapter } from '../../../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { NoopTtsProvider } from '../../../../src/ai/tts/tts-provider';
import { InMemoryOnCallRepository } from '../../../../src/oncall/rotation';
import { InMemoryProposalRepository, createProposal } from '../../../../src/proposals/proposal';
import type { LLMGateway, LLMResponse } from '../../../../src/ai/gateway/gateway';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMockGateway(jsonContent: string): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: jsonContent,
      model: 'mock-model',
      provider: 'mock',
      tokenUsage: { input: 100, output: 50, total: 150 },
      latencyMs: 10,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

function makeAdapter(
  gateway: LLMGateway,
  store: VoiceSessionStore,
  proposalRepo: InMemoryProposalRepository,
  ttsProvider = new NoopTtsProvider(),
) {
  return new InAppVoiceAdapter({
    gateway,
    proposalRepo,
    ttsProvider,
    onCallRepo: new InMemoryOnCallRepository(),
    sessionStore: store,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('P8-009 — InAppVoiceAdapter', () => {
  let store: VoiceSessionStore;
  let proposalRepo: InMemoryProposalRepository;
  let gateway: LLMGateway;

  beforeEach(() => {
    store = new VoiceSessionStore();
    proposalRepo = new InMemoryProposalRepository();
    gateway = makeMockGateway(JSON.stringify({
      intentType: 'create_appointment',
      confidence: 0.92,
      reasoning: 'user wants to schedule',
      extractedEntities: { customerName: 'Smith' },
    }));
  });

  it('startSession creates a session, transitions to identifying, and returns a sessionId', async () => {
    const adapter = makeAdapter(gateway, store, proposalRepo);
    const sessionId = await adapter.startSession('tenant-1', 'user-1', 'conv-1');

    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);

    const session = store.get(sessionId);
    expect(session).toBeDefined();
    // After startSession: idle → greeting (greeted_ok auto-fired) → identifying
    expect(session!.machine.currentState).toBe('identifying');
    expect(session!.tenantId).toBe('tenant-1');
  });

  it('startSession calls ttsProvider for the greeting', async () => {
    const tts = new NoopTtsProvider();
    const synthSpy = vi.spyOn(tts, 'synthesize');
    const adapter = makeAdapter(gateway, store, proposalRepo, tts);

    await adapter.startSession('tenant-1', 'user-1', 'conv-1');

    // The greeting side effect should have triggered at least one TTS call.
    expect(synthSpy).toHaveBeenCalled();
    const firstCall = synthSpy.mock.calls[0][0];
    expect(firstCall.text).toContain('Thank you for calling');
  });

  it('handleInput in identifying state dispatches unknown_caller (no pool)', async () => {
    const adapter = makeAdapter(gateway, store, proposalRepo);
    const sessionId = await adapter.startSession('tenant-1', 'user-1', 'conv-1');

    // No pool → unknown_caller → FSM should move to ask_caller
    const result = await adapter.handleInput(sessionId, 'John Smith');

    const session = store.get(sessionId)!;
    expect(['ask_caller', 'escalating']).toContain(session.machine.currentState);
    expect(result.state).toBe(session.machine.currentState);
  });

  it('classifyIntent is called in intent_capture state', async () => {
    const completeSpy = vi.fn(async () => ({
      content: JSON.stringify({
        intentType: 'create_appointment',
        confidence: 0.92,
        reasoning: 'user wants to schedule',
        extractedEntities: { customerName: 'Smith' },
      }),
      model: 'mock-model',
      provider: 'mock',
      tokenUsage: { input: 100, output: 50, total: 150 },
      latencyMs: 10,
    } satisfies LLMResponse));

    const spyGateway = { complete: completeSpy } as unknown as LLMGateway;
    const adapter = makeAdapter(spyGateway, store, proposalRepo);
    const sessionId = await adapter.startSession('tenant-1', 'user-1', 'conv-1');

    // Fast-path to intent_capture: dispatch caller_known manually
    const session = store.get(sessionId)!;
    session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
    // FSM now in intent_capture

    await adapter.handleInput(sessionId, 'I want to schedule an appointment');

    // classifyIntent calls gateway.complete
    expect(completeSpy).toHaveBeenCalled();
  });

  it('create_proposal side effect calls proposalRepo.create', async () => {
    const createSpy = vi.spyOn(proposalRepo, 'create');
    const adapter = makeAdapter(gateway, store, proposalRepo);
    const sessionId = await adapter.startSession('tenant-1', 'user-1', 'conv-1');

    const session = store.get(sessionId)!;

    // Fast-path: manually drive FSM to intent_confirm state
    // idle→greeting→identifying (done by startSession)
    session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
    // now in intent_capture
    session.machine.dispatch({
      type: 'intent_classified',
      intentType: 'create_appointment',
      entities: { customerName: 'Smith' },
      confidence: 0.92,
    });
    // now in entity_resolution
    session.machine.dispatch({
      type: 'entity_resolved',
      refs: { customerId: 'cust-1' },
    });
    // now in intent_confirm — dispatch confirmed to trigger create_proposal
    const sideEffects = session.machine.dispatch({ type: 'confirmed' });

    // Execute the side effects manually via the adapter's internal method.
    // We'll do it through handleInput but need the FSM to be in proposal_draft.
    // Actually the FSM transitions to proposal_draft after confirmed + create_proposal
    // side effect. Let's verify by looking at the current state.
    expect(session.machine.currentState).toBe('proposal_draft');
    expect(sideEffects.some((e) => e.type === 'create_proposal')).toBe(true);

    // Now the adapter receives a proposal_queued event to close the loop.
    // We test that when we call handleInput from intent_confirm state directly
    // the proposal gets created. Let's reset and do it through the adapter.
    const store2 = new VoiceSessionStore();
    const repo2 = new InMemoryProposalRepository();
    const createSpy2 = vi.spyOn(repo2, 'create');
    const gw2 = makeMockGateway(
      JSON.stringify({ answer: 'yes', reasoning: 'confirmed' }),
    );
    const adapter2 = makeAdapter(gw2, store2, repo2);
    const sid2 = await adapter2.startSession('tenant-1', 'user-1', 'conv-1');
    const sess2 = store2.get(sid2)!;
    sess2.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
    sess2.machine.dispatch({
      type: 'intent_classified',
      intentType: 'create_appointment',
      entities: { customerName: 'Smith' },
      confidence: 0.92,
    });
    sess2.machine.dispatch({
      type: 'entity_resolved',
      refs: { customerId: 'cust-1' },
    });
    // FSM is now in intent_confirm — handleInput will call confirmIntent
    await adapter2.handleInput(sid2, 'yes');

    // After confirmed, the FSM produces a create_proposal side effect.
    expect(createSpy2).toHaveBeenCalled();
  });

  it('ttsProvider.synthesize is called for tts_play side effects', async () => {
    const tts = new NoopTtsProvider();
    const synthSpy = vi.spyOn(tts, 'synthesize');
    const adapter = makeAdapter(gateway, store, proposalRepo, tts);
    const sessionId = await adapter.startSession('tenant-1', 'user-1', 'conv-1');

    // startSession produces a tts_play for the greeting.
    expect(synthSpy).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Thank you for calling') }),
    );
  });

  it('SSE clients are notified on state change', async () => {
    const adapter = makeAdapter(gateway, store, proposalRepo);
    const sessionId = await adapter.startSession('tenant-1', 'user-1', 'conv-1');

    const events: string[] = [];
    const session = store.get(sessionId)!;
    session.sseClients.add((payload) => events.push(payload));

    // Trigger a state change by sending input.
    await adapter.handleInput(sessionId, 'Hello');

    expect(events.length).toBeGreaterThan(0);
    const parsed = JSON.parse(events[0]) as { state: string };
    expect(typeof parsed.state).toBe('string');
  });

  it('endSession dispatches session_ended and removes the session from the store', async () => {
    const adapter = makeAdapter(gateway, store, proposalRepo);
    const sessionId = await adapter.startSession('tenant-1', 'user-1', 'conv-1');

    expect(store.get(sessionId)).toBeDefined();
    await adapter.endSession(sessionId);
    expect(store.get(sessionId)).toBeUndefined();
  });

  it('endSession is idempotent (does not throw on unknown sessionId)', async () => {
    const adapter = makeAdapter(gateway, store, proposalRepo);
    await expect(adapter.endSession('nonexistent-session')).resolves.not.toThrow();
  });

  it('handleInput throws when session is not found', async () => {
    const adapter = makeAdapter(gateway, store, proposalRepo);
    await expect(adapter.handleInput('ghost-id', 'hello')).rejects.toThrow('ghost-id');
  });

  it('pushSseEvent broadcasts to all registered SSE clients', async () => {
    const adapter = makeAdapter(gateway, store, proposalRepo);
    const sessionId = await adapter.startSession('tenant-1', 'user-1', 'conv-1');

    const received: string[] = [];
    const session = store.get(sessionId)!;
    session.sseClients.add((p) => received.push(p));
    session.sseClients.add((p) => received.push(p));

    adapter.pushSseEvent(sessionId, { type: 'test', value: 42 });

    expect(received).toHaveLength(2);
    expect(JSON.parse(received[0])).toMatchObject({ type: 'test', value: 42 });
  });

  it('transcript is updated on each handleInput call', async () => {
    const adapter = makeAdapter(gateway, store, proposalRepo);
    const sessionId = await adapter.startSession('tenant-1', 'user-1', 'conv-1');

    await adapter.handleInput(sessionId, 'hello');
    await adapter.handleInput(sessionId, 'world');

    const session = store.get(sessionId);
    expect(session?.transcript).toContain('hello');
    expect(session?.transcript).toContain('world');
  });
});
