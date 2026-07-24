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
import type { TenantSettings, SettingsRepository } from '../../../src/settings/settings';
import type { CurrentQuoteResolver } from '../../../src/conversations/negotiation/current-quote-resolver';

/** A configured (opted-in) discount policy + a grounded $250 quote, for U6 tests. */
const u6DiscountDeps = {
  settingsRepo: {
    findByTenant: async () =>
      ({
        discountMaxBps: 1000,
        discountFloorCents: 15000,
        discountNeverBelowCatalog: true,
      }) as unknown as TenantSettings,
  } as Pick<SettingsRepository, 'findByTenant'>,
  negotiationQuoteResolver: {
    resolve: async () => ({ estimateId: 'est-1', quotedCents: 25000, catalogGrounded: true }),
  } as CurrentQuoteResolver,
};

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

function makeCtx(opts: {
  gateway: LLMGateway;
  withRepos?: boolean;
  settingsRepo?: Pick<SettingsRepository, 'findByTenant'>;
  negotiationQuoteResolver?: CurrentQuoteResolver;
  /**
   * RV-070 owner session = RIVET surface S2. When false/absent the session is
   * an unauthenticated inbound caller (surface S1), which the P4 allowlist
   * restricts to the S1 op set. Operator-grade intents (update_job,
   * draft_invoice, …) are only legitimate on an owner session, so tests that
   * pin that intent→proposal mapping run with `ownerSession: true`.
   */
  ownerSession?: boolean;
} = {
  gateway: makeGatewayReturning('{}'),
  withRepos: true,
}): BuiltCtx {
  const store = new VoiceSessionStore({ startInterval: false });
  const auditRepo = new InMemoryAuditRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const voiceSessionRepo = new InMemoryVoiceSessionRepository();
  const session = store.create('tenant-abc', 'telephony', {
    callSid: 'CA-test',
    ...(opts.ownerSession ? { ownerSession: true } : {}),
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
    ...(opts.settingsRepo ? { settingsRepo: opts.settingsRepo } : {}),
    ...(opts.negotiationQuoteResolver
      ? { negotiationQuoteResolver: opts.negotiationQuoteResolver }
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

  it('persists a proposal once the operator confirms the readback', async () => {
    // Sequence: classifier (turn 1) → confirmIntent (turn 2). Owner session
    // (surface S2) — `create_invoice` is an operator-grade op the P4 allowlist
    // reserves for S2; an unauthenticated caller (S1) is covered separately.
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
      ownerSession: true,
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

  it('maps an update_job intent to an update_job proposal (not the voice_clarification dead-end)', async () => {
    // Sequence: classifier (turn 1) → confirmIntent (turn 2). Pins
    // intentToProposalType's 'update_job' case — this surface previously
    // fell through to the `default: voice_clarification` branch, unlike
    // the worker (INTENT_TO_PROPOSAL_TYPE) and assistant (registry) maps,
    // which already draft real update_job proposals.
    const gateway = makeGatewayWithSequence([
      JSON.stringify({
        intentType: 'update_job',
        confidence: 0.95,
        reasoning: 'matches keywords',
        extractedEntities: { jobRef: 'Henderson', status: 'in_progress' },
      }),
      JSON.stringify({ answer: 'yes', reasoning: 'caller said yes' }),
    ]);
    const { processor, session, proposalRepo } = makeCtx({
      gateway,
      withRepos: true,
      ownerSession: true,
    });

    await processor.speechTurn({
      session,
      speechResult: 'mark the Henderson job in progress',
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
    expect(proposals[0]!.proposalType).toBe('update_job');
    expect(session.proposalIds).toEqual([proposals[0]!.id]);
  });

  // ─── Part A — real ai_run_id threads classify → event → payload → proposal ──

  it("links the persisted proposal to the classify call's REAL ai_run_id", async () => {
    const AI_RUN_ID = '11111111-1111-4111-8111-111111111111';
    // Turn 1 = classify (surfaces the persisted ai_runs id, exactly as the
    // real LLMGateway does after writing the row); turn 2 = confirmIntent
    // "yes" and deliberately carries NO aiRunId — the proposal must reuse the
    // classify turn's id captured in FSM context (lastAiRunId), not the
    // confirm turn's.
    const classify: LLMResponse = {
      content: JSON.stringify({
        intentType: 'create_invoice',
        confidence: 0.95,
        reasoning: 'matches keywords',
        extractedEntities: { customerName: 'Acme' },
      }),
      model: 'mock-model',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
      aiRunId: AI_RUN_ID,
    };
    const confirm: LLMResponse = {
      content: JSON.stringify({ answer: 'yes', reasoning: 'caller said yes' }),
      model: 'mock-model',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    };
    let i = 0;
    const seq = [classify, confirm];
    const gateway = {
      complete: vi.fn().mockImplementation(async () => seq[Math.min(i++, seq.length - 1)]),
    } as unknown as LLMGateway;

    const { processor, session, proposalRepo } = makeCtx({
      gateway,
      withRepos: true,
      ownerSession: true,
    });

    await processor.speechTurn({
      session,
      speechResult: 'I need an invoice for Acme',
      callSid: 'CA-test',
      tenantId: 'tenant-abc',
    });
    await processor.speechTurn({
      session,
      speechResult: 'yes that is correct',
      callSid: 'CA-test',
      tenantId: 'tenant-abc',
    });

    const proposals = await proposalRepo.findByTenant('tenant-abc');
    expect(proposals.length).toBe(1);
    // The proposal carries the REAL run id (not null, not a fabricated uuid).
    expect(proposals[0]!.aiRunId).toBe(AI_RUN_ID);
    // …and findByAiRun links back to it (the auditability invariant).
    const linked = await proposalRepo.findByAiRun('tenant-abc', AI_RUN_ID);
    expect(linked.map((p) => p.id)).toContain(proposals[0]!.id);
  });

  it('leaves ai_run_id null (never fabricated) when the classify call surfaced no run id', async () => {
    // Gateway persists no ai_runs row → no aiRunId on the response. The
    // proposal must be born with a null ai_run_id, NOT a random uuid (a
    // fabricated id violates proposals.ai_run_id's FK and silently drops the
    // proposal on Postgres — the P0 this thread supersedes).
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
      ownerSession: true,
    });

    await processor.speechTurn({
      session,
      speechResult: 'I need an invoice for Acme',
      callSid: 'CA-test',
      tenantId: 'tenant-abc',
    });
    await processor.speechTurn({
      session,
      speechResult: 'yes that is correct',
      callSid: 'CA-test',
      tenantId: 'tenant-abc',
    });

    const proposals = await proposalRepo.findByTenant('tenant-abc');
    expect(proposals.length).toBe(1);
    expect(proposals[0]!.aiRunId).toBeUndefined();
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

  it('does not fabricate an aiRunId on create_proposal (FK-safe)', async () => {
    // Regression (QA-2026-07-10): the telephony create_proposal path set
    // aiRunId to a random uuidv4, violating proposals.ai_run_id →
    // ai_runs(id). The swallowed FK error silently dropped EVERY voice
    // proposal on Postgres. The in-memory repo doesn't enforce the FK, so
    // this asserts the built proposal never carries a fabricated id — the
    // real-DB proof lives in
    // test/integration/voice-proposal-ai-run-fk.test.ts.
    // Owner session (S2) so the FK-safety assertion exercises the real
    // draft_invoice path, not the S1-coerced voice_clarification.
    const { processor, session, proposalRepo } = makeCtx({
      gateway: makeGatewayReturning('{}'),
      withRepos: true,
      ownerSession: true,
    });
    await processor.executeSideEffects(
      session,
      [
        {
          type: 'create_proposal',
          payload: { intent: 'create_invoice', entities: {} },
        },
      ],
      'tenant-abc',
    );
    const proposals = await proposalRepo.findByTenant('tenant-abc');
    expect(proposals.length).toBe(1);
    expect(proposals[0]!.aiRunId).toBeUndefined();
  });

  it('threads a real aiRunId through create_proposal when the side effect provides one', async () => {
    const { processor, session, proposalRepo } = makeCtx({
      gateway: makeGatewayReturning('{}'),
      withRepos: true,
      ownerSession: true,
    });
    const realRunId = '11111111-2222-3333-4444-555555555555';
    await processor.executeSideEffects(
      session,
      [
        {
          type: 'create_proposal',
          payload: { intent: 'create_invoice', entities: {}, aiRunId: realRunId },
        },
      ],
      'tenant-abc',
    );
    const proposals = await proposalRepo.findByTenant('tenant-abc');
    expect(proposals.length).toBe(1);
    expect(proposals[0]!.aiRunId).toBe(realRunId);
  });
});

// ─── RIVET P4 — S1 surface allowlist at proposal creation ────────────────────

describe('createVoiceTurnProcessor — S1 surface enforcement (P4)', () => {
  it('coerces an S2-only intent (send_invoice) to voice_clarification on an unauthenticated S1 caller', async () => {
    // The default makeCtx session is a caller-known but NOT ownerSession
    // caller — i.e. surface S1. "Send the Henderson invoice to me" spoken by a
    // caller is an attack, not a request: it must never mint an S2 send.
    const { processor, session, proposalRepo, auditRepo } = makeCtx({
      gateway: makeGatewayReturning('{}'),
      withRepos: true,
    });
    await processor.executeSideEffects(
      session,
      [
        {
          type: 'create_proposal',
          payload: { intent: 'send_invoice', entities: { invoiceNumber: '1043' } },
        },
      ],
      'tenant-abc',
    );
    const proposals = await proposalRepo.findByTenant('tenant-abc');
    expect(proposals).toHaveLength(1);
    // The S2-only send is neutralized to a non-actionable clarification…
    expect(proposals[0]!.proposalType).toBe('voice_clarification');
    // …and stamped with the S1 surface so the execution boundary re-checks it.
    expect((proposals[0]!.sourceContext as Record<string, unknown>).surface).toBe('S1');
    // …and the block is audited.
    const audits = auditRepo.getAll();
    expect(audits.some((a) => a.eventType === 'voice.surface_violation_blocked')).toBe(true);
  });

  it('allows an S1-allowlisted intent (create_customer, self-signup) and stamps surface S1', async () => {
    const { processor, session, proposalRepo, auditRepo } = makeCtx({
      gateway: makeGatewayReturning('{}'),
      withRepos: true,
    });
    await processor.executeSideEffects(
      session,
      [
        {
          type: 'create_proposal',
          payload: { intent: 'create_customer', entities: { name: 'Elena Ruiz' } },
        },
      ],
      'tenant-abc',
    );
    const proposals = await proposalRepo.findByTenant('tenant-abc');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.proposalType).toBe('create_customer');
    expect((proposals[0]!.sourceContext as Record<string, unknown>).surface).toBe('S1');
    const audits = auditRepo.getAll();
    expect(audits.some((a) => a.eventType === 'voice.surface_violation_blocked')).toBe(false);
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

// ─── Codex P1 round 5 — onSessionTerminated awaitable + persist fields ──────

describe('createVoiceTurnProcessor — terminal hook + persist (Codex P1 r5)', () => {
  // VQ2-fix-5a — speechTurn awaits onSessionTerminated. Pre-fix the
  // callback was invoked sync (fire-and-forget); the Layer 2 entry
  // test's runSummary spend then either missed the runner's per-run
  // suite-tracker snapshot or contaminated the next run. We drive the
  // FSM to `terminated` BEFORE invoking speechTurn so the terminal
  // branch fires inside speechTurn.
  it('awaits onSessionTerminated before speechTurn returns', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const session = store.create('tenant-abc', 'telephony', { callSid: 'CA-x' });
    // Pre-seat the FSM in `terminated` via the global caller_hangup
    // guard so the speechTurn dispatch (which from the terminated
    // state will be ignored) leaves currentState === 'terminated' and
    // the terminal branch fires.
    session.machine.dispatch({
      type: 'incoming_call',
      callSid: 'CA-x',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });
    session.machine.dispatch({ type: 'caller_hangup' });
    expect(session.machine.currentState).toBe('terminated');

    let callbackResolvedAt = 0;
    const processor = createVoiceTurnProcessor({
      store,
      gateway: makeGatewayReturning('{}'),
      businessName: 'Acme',
      voiceSessionRepo: new InMemoryVoiceSessionRepository(),
      // Resolve only after a tick. If speechTurn is fire-and-forget,
      // it returns BEFORE this resolves and our timestamp ordering
      // assertion below fails.
      onSessionTerminated: async () => {
        await new Promise((r) => setTimeout(r, 10));
        callbackResolvedAt = Date.now();
      },
    });

    const beforeReturn = Date.now();
    await processor.speechTurn({
      session,
      speechResult: 'hello',
      callSid: 'CA-x',
      tenantId: 'tenant-abc',
    });
    const afterReturn = Date.now();

    // Callback must have resolved by the time speechTurn returned.
    expect(callbackResolvedAt).toBeGreaterThan(0);
    expect(callbackResolvedAt).toBeGreaterThanOrEqual(beforeReturn);
    expect(callbackResolvedAt).toBeLessThanOrEqual(afterReturn);
  });

  // VQ2-fix-5c — markEnded receives transcript + customerId. Pre-fix
  // the processor's persistSessionEnded omitted both fields (the
  // adapter's legacy persistSessionEnded passed them, but the legacy
  // path is bypassed because the processor sets terminalOutcome
  // first), so they were silently dropped from voice_sessions for
  // every session terminating via the extracted speechTurn.
  it('passes transcript and customerId to voiceSessionRepo.markEnded on terminate', async () => {
    type MarkEndedCall = Parameters<InMemoryVoiceSessionRepository['markEnded']>;
    const captured: MarkEndedCall[] = [];
    const fakeRepo: InMemoryVoiceSessionRepository = Object.assign(
      new InMemoryVoiceSessionRepository(),
      {
        markEnded: vi.fn(async (...args: MarkEndedCall) => {
          captured.push(args);
          return null;
        }),
      },
    );

    const store = new VoiceSessionStore({ startInterval: false });
    const session = store.create('tenant-abc', 'telephony', { callSid: 'CA-y' });
    session.customerId = 'cust-zzz';
    store.appendTranscript(session.id, {
      speaker: 'caller',
      text: 'hello world',
      ts: Date.now(),
    });
    session.machine.dispatch({
      type: 'incoming_call',
      callSid: 'CA-y',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: 'tenant-abc',
    });
    session.machine.dispatch({ type: 'caller_hangup' });
    expect(session.machine.currentState).toBe('terminated');

    const processor = createVoiceTurnProcessor({
      store,
      gateway: makeGatewayReturning('{}'),
      businessName: 'Acme',
      voiceSessionRepo: fakeRepo,
    });

    await processor.speechTurn({
      session,
      speechResult: 'whatever',
      callSid: 'CA-y',
      tenantId: 'tenant-abc',
    });

    // Wait one microtask so the fire-and-forget persist completes.
    await new Promise((r) => setImmediate(r));

    expect(captured.length).toBe(1);
    const [, , input] = captured[0]!;
    expect(input.customerId).toBe('cust-zzz');
    expect(input.transcript).toBeDefined();
    expect(input.transcript!.some((line) => line.includes('hello world'))).toBe(
      true,
    );
  });
});

// ─── N-003 — negotiation guardrail (live FSM) ───────────────────────────────

describe('createVoiceTurnProcessor — negotiation guardrail (N-003)', () => {
  it('deflects a negotiation turn: drafts an owner callback, speaks a holding line, stays in intent_capture', async () => {
    const gateway = makeGatewayReturning(
      JSON.stringify({
        intentType: 'negotiation',
        confidence: 0.95,
        reasoning: 'caller pushing on price',
        extractedEntities: {
          negotiationAsk: 'can you knock fifty bucks off?',
          customerName: 'Acme',
        },
      }),
    );
    const { processor, session, proposalRepo } = makeCtx({ gateway, withRepos: true });

    const sideEffects = await processor.speechTurn({
      session,
      speechResult: 'can you knock fifty bucks off?',
      callSid: 'CA-test',
      tenantId: 'tenant-abc',
    });

    // Owner callback created — the rich guardrail payload, not a generic
    // "Voice intent: negotiation".
    const proposals = await proposalRepo.findByTenant('tenant-abc');
    const cb = proposals.find((p) => p.proposalType === 'callback');
    expect(cb).toBeDefined();
    expect(cb!.payload.reason).toBe('customer_negotiation_followup');
    expect(cb!.payload.negotiationAskType).toBe('discount');
    expect(cb!.status).toBe('draft');

    // The agent deflected: spoke the holding line and did NOT advance the
    // funnel to intent_confirm or escalate.
    expect(
      sideEffects.some(
        (fx) =>
          fx.type === 'tts_play' &&
          /check with the owner/i.test((fx.payload as { text: string }).text),
      ),
    ).toBe(true);
    expect(session.machine.currentState).toBe('intent_capture');
  });

  // U6 (P2-036 V2) — live-call discount engine (additive, behind the policy gate).
  it('ALLOW: an in-policy live ask drafts a confidence-capped callback', async () => {
    const gateway = makeGatewayReturning(
      JSON.stringify({
        intentType: 'negotiation',
        confidence: 0.95,
        reasoning: 'price push',
        extractedEntities: { negotiationAsk: 'can you do $230?', customerName: 'Acme' },
      }),
    );
    const { processor, session, proposalRepo } = makeCtx({ gateway, withRepos: true, ...u6DiscountDeps });

    await processor.speechTurn({
      session,
      speechResult: 'can you do $230?',
      callSid: 'CA-test',
      tenantId: 'tenant-abc',
    });

    const cb = (await proposalRepo.findByTenant('tenant-abc')).find(
      (p) => p.proposalType === 'callback',
    );
    expect(cb).toBeDefined();
    expect((cb!.payload._meta as { overallConfidence: string }).overallConfidence).toBe('low');
    expect(cb!.payload.approvedDiscountBps).toBe(800); // $250→$230 = 8%, within 10% cap
    expect(cb!.status).toBe('draft'); // capped → never auto-approves
  });

  it('CLARIFY: an ambiguous live discount ask drafts a voice_clarification', async () => {
    const gateway = makeGatewayReturning(
      JSON.stringify({
        intentType: 'negotiation',
        confidence: 0.95,
        reasoning: 'price push',
        extractedEntities: { negotiationAsk: 'come on, give me a deal', customerName: 'Acme' },
      }),
    );
    const { processor, session, proposalRepo } = makeCtx({ gateway, withRepos: true, ...u6DiscountDeps });

    await processor.speechTurn({
      session,
      speechResult: 'come on, give me a deal',
      callSid: 'CA-test',
      tenantId: 'tenant-abc',
    });

    const vc = (await proposalRepo.findByTenant('tenant-abc')).find(
      (p) => p.proposalType === 'voice_clarification',
    );
    expect(vc).toBeDefined();
    expect(vc!.payload.reason).toBe('ambiguous_discount_target');
  });
});
