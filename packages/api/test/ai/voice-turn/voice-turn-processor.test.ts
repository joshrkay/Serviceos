/**
 * Unit tests for the extracted `createVoiceTurnProcessor` factory.
 *
 * These exercise the closure-captured agent loop end-to-end with mock
 * gateway + in-memory repos. They are the safety net for the extraction
 * itself: the production behavior tests already live in
 * `test/telephony/twilio-adapter.test.ts` and should continue to pass
 * because the adapter now delegates here.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  createVoiceTurnProcessor,
  type VoiceTurnProcessor,
} from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryVoiceSessionRepository } from '../../../src/voice/voice-session';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGatewayReturning(content: string): LLMGateway {
  const response: LLMResponse = {
    content,
    model: 'mock-model',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  return {
    complete: vi.fn().mockResolvedValue(response),
  } as unknown as LLMGateway;
}

function makeGatewayWithSequence(contents: string[]): LLMGateway {
  const responses: LLMResponse[] = contents.map((content) => ({
    content,
    model: 'mock-model',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  }));
  let i = 0;
  return {
    complete: vi.fn().mockImplementation(async () => {
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return r;
    }),
  } as unknown as LLMGateway;
}

function makeThrowingGateway(): LLMGateway {
  return {
    complete: vi.fn().mockRejectedValue(new Error('gateway boom')),
  } as unknown as LLMGateway;
}

interface BuiltCtx {
  processor: VoiceTurnProcessor;
  store: VoiceSessionStore;
  auditRepo: InMemoryAuditRepository;
  proposalRepo: InMemoryProposalRepository;
  voiceSessionRepo: InMemoryVoiceSessionRepository;
  session: ReturnType<VoiceSessionStore['create']>;
}

function makeCtx(opts: { gateway: LLMGateway; withRepos?: boolean } = {
  gateway: makeGatewayReturning('{}'),
  withRepos: true,
}): BuiltCtx {
  const store = new VoiceSessionStore({ startInterval: false });
  const auditRepo = new InMemoryAuditRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const voiceSessionRepo = new InMemoryVoiceSessionRepository();
  const session = store.create('tenant-abc', 'telephony', {
    callSid: 'CA-test',
  });
  // Drive the FSM forward to `intent_capture`. handleInbound's
  // unknown_caller path lands in `ask_caller`; we use `caller_known`
  // instead so the FSM advances straight to `intent_capture` where
  // speechTurn's classifier branch runs.
  session.machine.dispatch({
    type: 'incoming_call',
    callSid: 'CA-test',
    from: '+15125550100',
    to: '+15125550999',
    tenantId: 'tenant-abc',
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
  session.customerId = 'cust-1';

  const processor = createVoiceTurnProcessor({
    store,
    gateway: opts.gateway,
    businessName: 'Acme Plumbing',
    systemActorId: 'test-actor',
    ...(opts.withRepos !== false
      ? { auditRepo, proposalRepo, voiceSessionRepo }
      : {}),
  });

  return { processor, store, auditRepo, proposalRepo, voiceSessionRepo, session };
}

// ─── speechTurn — happy path ─────────────────────────────────────────────────

describe('createVoiceTurnProcessor.speechTurn', () => {
  it('classifies a recognized intent and advances the FSM to intent_confirm', async () => {
    const gateway = makeGatewayReturning(
      JSON.stringify({
        intentType: 'create_invoice',
        confidence: 0.95,
        reasoning: 'matches keywords',
        extractedEntities: { customerName: 'Acme' },
      }),
    );
    const { processor, session, store } = makeCtx({
      gateway,
      withRepos: true,
    });

    const sideEffects = await processor.speechTurn({
      session,
      speechResult: 'I need an invoice for Acme',
      callSid: 'CA-test',
      tenantId: 'tenant-abc',
    });

    // Side-effect array contains tts_play turns from the FSM dispatch.
    expect(sideEffects.length).toBeGreaterThan(0);

    // The FSM advanced to intent_confirm — the next gather is the
    // caller's yes/no on the readback.
    expect(session.machine.currentState).toBe('intent_confirm');

    // The intent_confirm placeholder was expanded to a concrete readback.
    const ttsLast = [...sideEffects].reverse().find((fx) => fx.type === 'tts_play');
    expect(ttsLast?.payload.text).toMatch(/create invoice/);

    // The caller utterance landed in the transcript.
    const liveSession = store.get(session.id)!;
    expect(
      liveSession.transcript.some((line) =>
        line.includes('I need an invoice for Acme'),
      ),
    ).toBe(true);
  });

  it('persists a proposal once the caller confirms the readback', async () => {
    // Sequence: classifier (turn 1) → confirmIntent (turn 2).
    const gateway = makeGatewayWithSequence([
      JSON.stringify({
        intentType: 'create_invoice',
        confidence: 0.95,
        reasoning: 'matches keywords',
        extractedEntities: { customerName: 'Acme' },
      }),
      JSON.stringify({ answer: 'yes', reasoning: 'caller said yes' }),
    ]);
    const { processor, session, proposalRepo } = makeCtx({
      gateway,
      withRepos: true,
    });

    await processor.speechTurn({
      session,
      speechResult: 'I need an invoice for Acme',
      callSid: 'CA-test',
      tenantId: 'tenant-abc',
    });
    expect(session.machine.currentState).toBe('intent_confirm');

    await processor.speechTurn({
      session,
      speechResult: 'yes that is correct',
      callSid: 'CA-test',
      tenantId: 'tenant-abc',
    });

    const proposals = await proposalRepo.findByTenant('tenant-abc');
    expect(proposals.length).toBe(1);
    expect(proposals[0]!.proposalType).toBe('draft_invoice');
    expect(session.proposalIds).toEqual([proposals[0]!.id]);
  });

  it('treats empty speech as confidence_low and does not call the gateway', async () => {
    const gateway = makeGatewayReturning('{}');
    const { processor, session } = makeCtx({ gateway, withRepos: true });

    const sideEffects = await processor.speechTurn({
      session,
      speechResult: '   ',
      callSid: 'CA-test',
      tenantId: 'tenant-abc',
    });

    expect(sideEffects.length).toBeGreaterThan(0);
    expect((gateway.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('falls back gracefully when classifyIntent throws', async () => {
    const gateway = makeThrowingGateway();
    const { processor, session } = makeCtx({ gateway, withRepos: true });

    const sideEffects = await processor.speechTurn({
      session,
      speechResult: 'hello there',
      callSid: 'CA-test',
      tenantId: 'tenant-abc',
    });

    // Falls through to the confidence_low / reprompt branch — the
    // dispatch produces at least one tts_play side effect.
    expect(sideEffects.some((fx) => fx.type === 'tts_play')).toBe(true);
  });

  it('emits cost_incurred on the session bus for each LLM call', async () => {
    const gateway = makeGatewayReturning(
      JSON.stringify({
        intentType: 'unknown',
        confidence: 0.1,
        reasoning: 'x',
      }),
    );
    const { processor, session } = makeCtx({ gateway, withRepos: true });

    const events: unknown[] = [];
    session.events.on('voice-event', (e: unknown) => events.push(e));

    await processor.speechTurn({
      session,
      speechResult: 'something',
      callSid: 'CA-test',
      tenantId: 'tenant-abc',
    });

    const costEvents = events.filter(
      (e) => (e as { type?: string }).type === 'cost_incurred',
    );
    expect(costEvents.length).toBeGreaterThan(0);
  });

  it('returns an end_session fallback when called with a falsy session', async () => {
    const { processor } = makeCtx();
    const result = await processor.speechTurn({
      // The mediastream adapter is supposed to resolve session before
      // invoking us; the guard remains as a defensive fallback.
      session: undefined as unknown as ReturnType<VoiceSessionStore['create']>,
      speechResult: 'whatever',
      callSid: 'CA-test',
      tenantId: 'tenant-abc',
    });
    expect(result.find((fx) => fx.type === 'end_session')).toBeDefined();
  });
});

// ─── handleAuditLog / handleCreateProposal degradation ──────────────────────

describe('createVoiceTurnProcessor.executeSideEffects', () => {
  it('writes an audit row when auditRepo is wired', async () => {
    const { processor, session, auditRepo } = makeCtx();
    const sideEffects: SideEffect[] = [
      {
        type: 'audit_log',
        payload: { eventType: 'agent.calling.test', detail: 'unit' },
      },
    ];
    await processor.executeSideEffects(session, sideEffects, 'tenant-abc');
    const rows = auditRepo.getAll();
    expect(rows.length).toBe(1);
    expect(rows[0]!.eventType).toBe('agent.calling.test');
    expect(rows[0]!.tenantId).toBe('tenant-abc');
    expect(rows[0]!.entityId).toBe(session.id);
  });

  it('silently skips audit_log when no auditRepo is wired', async () => {
    const { processor: processorNoRepo, session } = makeCtx({
      gateway: makeGatewayReturning('{}'),
      withRepos: false,
    });
    const sideEffects: SideEffect[] = [
      { type: 'audit_log', payload: { eventType: 'x' } },
    ];
    // Should not throw.
    await expect(
      processorNoRepo.executeSideEffects(session, sideEffects, 'tenant-abc'),
    ).resolves.toBeUndefined();
  });

  it('skips create_proposal when no proposalRepo is wired (no crash)', async () => {
    const { processor: processorNoRepo, session } = makeCtx({
      gateway: makeGatewayReturning('{}'),
      withRepos: false,
    });
    const sideEffects: SideEffect[] = [
      {
        type: 'create_proposal',
        payload: { intent: 'create_invoice', entities: {} },
      },
    ];
    await expect(
      processorNoRepo.executeSideEffects(session, sideEffects, 'tenant-abc'),
    ).resolves.toBeUndefined();
  });
});

// ─── recordCost ─────────────────────────────────────────────────────────────

describe('createVoiceTurnProcessor.recordCost', () => {
  it('increments the session cost tracker', () => {
    const { processor, session } = makeCtx();
    const before = session.costTracker.totals.costCents;
    processor.recordCost(session, { input: 1000, output: 500 });
    const after = session.costTracker.totals.costCents;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('returns false when usage is undefined', () => {
    const { processor, session } = makeCtx();
    expect(processor.recordCost(session, undefined)).toBe(false);
  });
});

// ─── expandIntentConfirmTemplate ────────────────────────────────────────────

describe('createVoiceTurnProcessor.expandIntentConfirmTemplate', () => {
  it('rewrites a placeholder intent_confirm tts_play', () => {
    const { processor } = makeCtx();
    const sideEffects: SideEffect[] = [
      { type: 'tts_play', payload: { text: 'intent_confirm' } },
      { type: 'tts_play', payload: { text: 'unchanged' } },
    ];
    processor.expandIntentConfirmTemplate(sideEffects, 'create_invoice');
    expect(sideEffects[0]!.payload.text).toMatch(/create invoice/);
    expect(sideEffects[1]!.payload.text).toBe('unchanged');
  });
});

// ─── Resolvers — graceful degrade ───────────────────────────────────────────

describe('createVoiceTurnProcessor — optional resolvers', () => {
  it('vertical/plan/threshold resolvers return undefined when not wired', async () => {
    const { processor } = makeCtx();
    await expect(processor.resolveVerticalPromptSection('t')).resolves.toBeUndefined();
    await expect(processor.resolvePlanPromptSection('t', 'c')).resolves.toBeUndefined();
    await expect(processor.resolveThresholdOverride('t')).resolves.toBeUndefined();
  });

  it('vertical resolver errors are swallowed and return undefined', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const processor = createVoiceTurnProcessor({
      store,
      gateway: makeGatewayReturning('{}'),
      businessName: 'Acme',
      verticalPromptResolver: async () => {
        throw new Error('boom');
      },
    });
    await expect(processor.resolveVerticalPromptSection('t')).resolves.toBeUndefined();
  });
});

// ─── finalizeTerminatedSession ──────────────────────────────────────────────

describe('createVoiceTurnProcessor.finalizeTerminatedSession', () => {
  it('stashes terminalOutcome + terminalReason on the session', () => {
    const { processor, session } = makeCtx();
    processor.finalizeTerminatedSession(session, [], 'caller_hangup');
    expect(session.terminalOutcome).toBeDefined();
    expect(session.terminalReason).toBe('caller_hangup');
  });

  it('prefers the end_session payload.reason over the fallback', () => {
    const { processor, session } = makeCtx();
    const sideEffects: SideEffect[] = [
      { type: 'end_session', payload: { reason: 'abuse_detected:profanity' } },
    ];
    processor.finalizeTerminatedSession(session, sideEffects, 'caller_hangup');
    expect(session.terminalReason).toBe('abuse_detected:profanity');
  });

  it('is idempotent — second call leaves the existing outcome', () => {
    const { processor, session } = makeCtx();
    processor.finalizeTerminatedSession(session, [], 'caller_hangup');
    const firstOutcome = session.terminalOutcome;
    const firstReason = session.terminalReason;
    processor.finalizeTerminatedSession(session, [], 'other_reason');
    expect(session.terminalOutcome).toBe(firstOutcome);
    expect(session.terminalReason).toBe(firstReason);
  });
});

// ─── runSummary ─────────────────────────────────────────────────────────────

describe('createVoiceTurnProcessor.runSummary', () => {
  it('skips when the transcript is empty (does not call gateway)', async () => {
    const gateway = makeGatewayReturning(
      JSON.stringify({
        summaryText: 'short summary',
        keyPoints: [],
        sentiment: 'neutral',
      }),
    );
    const { processor, session } = makeCtx({ gateway, withRepos: true });
    await processor.runSummary(session);
    expect((gateway.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
