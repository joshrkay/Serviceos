/**
 * PRIV-3 — handler level: a caller who recites a card number on a live call.
 *
 * The audit trigger: "can I just pay now — my card is 4111 1111 1111 1111".
 * Before the fix the digits landed verbatim in the stored transcript turn
 * (call_transcript_turns via VoiceSessionStore.persistTurn), the in-memory
 * session transcript (copied to voice_sessions.transcript at hangup) and the
 * classify_intent request sent to the LLM provider.
 *
 * Driven through the real entry points with the REAL LLMGateway (only the
 * provider is stubbed, so what reaches the provider is what the gateway
 * dispatches) and a real VoiceSessionStore whose turn repo records writes:
 *   - Media Streams: TwilioGatherAdapter#processCallerUtterance (the shipped
 *     `speechTurn` dep of the stream adapter),
 *   - Gather: TwilioGatherAdapter#handleGather.
 */
import { describe, expect, it, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import {
  LLMGateway,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from '../../src/ai/gateway/gateway';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { createVoiceTurnProcessor } from '../../src/ai/voice-turn/create-voice-turn-processor';
import { createVulnerabilityTriageHook } from '../../src/ai/agents/customer-calling/vulnerability-triage-hook';
import { gradeVulnerability } from '../../src/ai/agents/customer-calling/vulnerability-grader';

const TENANT = 'tenant-pan';
// The card's digits, run together or spaced. Not a bare '4111': a random
// uuid (a proposal id) contains that often enough to fail the suite.
const CARD_DIGITS = /4111\D?1111/;
const SPOKEN = 'can I just pay now, my card is 4111 1111 1111 1111 expires 09/27';
const STORED = 'can I just pay now, my card is [card number] expires 09/27';

/**
 * `classifierReply` — what the provider answers every request with.
 * `vulnerabilityTriage` — wire the per-turn vulnerability grade through the
 * same gateway, as app.ts does: the one provider request on the Gather path
 * that carries the call's earlier turns (`priorTurns`), not just this one.
 */
function harness(
  opts: { classifierReply?: string; vulnerabilityTriage?: boolean } = {},
) {
  const providerRequests: LLMRequest[] = [];
  const provider: LLMProvider = {
    name: 'stub',
    isAvailable: async () => true,
    complete: async (req: LLMRequest): Promise<LLMResponse> => {
      providerRequests.push(req);
      return {
        content: opts.classifierReply ?? '{"intentType":"unknown","confidence":0,"reasoning":"x"}',
        model: 'gpt-4o-mini',
        provider: 'openai',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      };
    },
  };
  const gateway = new LLMGateway({ defaultProvider: 'stub' }, new Map([['stub', provider]]));
  const recordTurn = vi.fn(async () => undefined);
  const redactCardNumberTurns = vi.fn(async (input: { turns: unknown[] }) => input.turns.length);
  const store = new VoiceSessionStore({
    startInterval: false,
    callTranscriptTurnRepo: { recordTurn, redactCardNumberTurns } as never,
  });
  const vulnerabilityTriageHook = opts.vulnerabilityTriage
    ? createVulnerabilityTriageHook({
        isEnabledForTenant: async () => true,
        grade: (input, budget) =>
          gradeVulnerability(input, {
            llm: {
              complete: async ({ prompt }: { prompt: string }) => {
                const res = await gateway.complete({
                  taskType: 'grade_vulnerability',
                  tenantId: input.tenantId,
                  messages: [{ role: 'user', content: prompt }],
                });
                return { text: res.content, tokenUsage: res.tokenUsage, model: res.model };
              },
            },
            ...budget,
          }),
        triageEvents: { record: vi.fn(async () => ({}) as never), listBySession: vi.fn(async () => []) },
      })
    : undefined;
  const adapter = new TwilioGatherAdapter({
    store,
    gateway,
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    ...(vulnerabilityTriageHook ? { vulnerabilityTriageHook } : {}),
  });
  return { adapter, store, recordTurn, redactCardNumberTurns, providerRequests };
}

async function startCall(h: ReturnType<typeof harness>, callSid: string) {
  await h.adapter.handleInbound({ callSid, from: '+15125550100', to: '+15125550999', tenantId: TENANT });
  const session = h.store.findByCallSid(callSid)!;
  if (session.machine.currentState === 'ask_caller') {
    session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
  }
  return session;
}

async function settle() {
  // persistTurn is fire-and-forget (Promise.resolve().then(...)).
  await new Promise<void>((r) => { setTimeout(r, 0); });
}

function assertNoCardNumber(h: ReturnType<typeof harness>, sessionTranscript: string[]) {
  const storedCallerTurns = h.recordTurn.mock.calls
    .map((c) => (c as unknown as [{ speaker: string; text: string }])[0])
    .filter((t) => t.speaker === 'caller')
    .map((t) => t.text);
  expect(storedCallerTurns).toEqual([STORED]);
  expect(sessionTranscript).toContain(`caller: ${STORED}`);
  expect(JSON.stringify(sessionTranscript)).not.toMatch(CARD_DIGITS);
  expect(h.providerRequests.length).toBeGreaterThan(0);
  for (const req of h.providerRequests) {
    expect(JSON.stringify(req.messages)).not.toContain('4111 1111 1111 1111');
  }
}

describe('PRIV-3 — a recited card number on a live call', () => {
  it('Media Streams (processCallerUtterance): the stored turn, session transcript and provider request carry the marker, not the digits', async () => {
    const h = harness();
    const session = await startCall(h, 'CA-pan-ms');
    await h.adapter.processCallerUtterance({
      sessionId: session.id,
      callSid: 'CA-pan-ms',
      speechResult: SPOKEN,
      tenantId: TENANT,
    });
    await settle();
    assertNoCardNumber(h, session.transcript);
  });

  it('Gather (handleGather): the stored turn, session transcript and provider request carry the marker, not the digits', async () => {
    const h = harness();
    const session = await startCall(h, 'CA-pan-gather');
    await h.adapter.handleGather({
      sessionId: session.id,
      callSid: 'CA-pan-gather',
      speechResult: SPOKEN,
      confidence: 0.95,
      tenantId: TENANT,
    });
    await settle();
    assertNoCardNumber(h, session.transcript);
  });

  // Spanish speech recognition can return the card as words, which the
  // digit-only scrubber let through to every store and the provider.
  it('Gather (handleGather): a card read as Spanish words carries the marker, not the words', async () => {
    const h = harness();
    const session = await startCall(h, 'CA-pan-gather-es');
    await h.adapter.handleGather({
      sessionId: session.id,
      callSid: 'CA-pan-gather-es',
      speechResult: 'quiero pagar, mi tarjeta es cuatro uno uno uno, uno uno uno uno, uno uno uno uno, uno uno uno uno',
      confidence: 0.95,
      tenantId: TENANT,
    });
    await settle();
    const storedCallerTurns = h.recordTurn.mock.calls
      .map((c) => (c as unknown as [{ speaker: string; text: string }])[0])
      .filter((t) => t.speaker === 'caller')
      .map((t) => t.text);
    expect(storedCallerTurns).toEqual(['quiero pagar, mi tarjeta es [card number]']);
    expect(session.transcript).toContain('caller: quiero pagar, mi tarjeta es [card number]');
    expect(h.providerRequests.length).toBeGreaterThan(0);
    for (const req of h.providerRequests) {
      expect(JSON.stringify(req.messages)).not.toContain('cuatro uno uno uno');
    }
  });
});

// A caller who pauses mid-number: each Gather turn alone is under 13 digits.
describe('PRIV-3 follow-up — a card number split across Gather turns', () => {
  it('rewrites every caller turn that held part of it, in the session transcript and the stored rows', async () => {
    // A confident booking keeps the call classifying turn after turn (an
    // "unknown" would hand off before the card is complete).
    const h = harness({
      classifierReply: '{"intentType":"create_appointment","confidence":0.95,"reasoning":"x","extractedEntities":{}}',
      vulnerabilityTriage: true,
    });
    const callSid = 'CA-pan-split-gather';
    const session = await startCall(h, callSid);
    let requestsBeforeCompletingTurn = 0;
    for (const speechResult of ['my card is 4111 1111', '1111', '1111 thanks']) {
      requestsBeforeCompletingTurn = h.providerRequests.length;
      await h.adapter.handleGather({ sessionId: session.id, callSid, speechResult, confidence: 0.95, tenantId: TENANT });
      await settle();
    }
    await session.cardRedactionWrites;

    // The completing turn's vulnerability grade carries the call's earlier
    // turns as context: by the time it is sent they are the marker too, so
    // no request after the card is complete holds a fragment of it.
    const afterCompletingTurn = h.providerRequests.slice(requestsBeforeCompletingTurn);
    expect(afterCompletingTurn.map((req) => req.taskType)).toEqual(
      expect.arrayContaining(['grade_vulnerability', 'classify_intent']),
    );
    const grade = afterCompletingTurn.find((req) => req.taskType === 'grade_vulnerability')!;
    expect(JSON.stringify(grade.messages)).toContain('[card number]');
    for (const req of afterCompletingTurn) {
      const sent = JSON.stringify(req.messages);
      expect(sent).not.toMatch(CARD_DIGITS);
      expect(sent).not.toMatch(/\b1111\b/);
    }

    const callerLines = session.transcript.filter((line) => line.startsWith('caller: '));
    expect(callerLines).toEqual([
      'caller: my card is [card number]',
      'caller: [card number]',
      'caller: [card number] thanks',
    ]);
    // Agent lines are never part of the window and are left as spoken.
    expect(session.transcript.filter((line) => line.startsWith('agent: ') && line.includes('[card number]'))).toEqual(
      [],
    );
    expect(JSON.stringify(session.transcript)).not.toMatch(CARD_DIGITS);

    expect(h.redactCardNumberTurns).toHaveBeenCalledTimes(1);
    const [rewrite] = h.redactCardNumberTurns.mock.calls[0] as unknown as [
      { callSid: string; sessionId: string; turns: Array<{ turnIndex: number; text: string }> },
    ];
    expect(rewrite.callSid).toBe(callSid);
    expect(rewrite.sessionId).toBe(session.id);
    expect(rewrite.turns.map((t) => t.text)).toEqual(['my card is [card number]', '[card number]', '[card number] thanks']);
    expect(rewrite.turns.map((t) => session.transcript[t.turnIndex])).toEqual(callerLines);
    // The completing turn's own row was inserted already rewritten.
    const storedCallerTurns = h.recordTurn.mock.calls
      .map((c) => (c as unknown as [{ speaker: string; text: string }])[0])
      .filter((t) => t.speaker === 'caller')
      .map((t) => t.text);
    expect(storedCallerTurns.at(-1)).toBe('[card number] thanks');
  });
});

/**
 * Review round 1 — the stored turn was scrubbed, but the RAW speechResult
 * still drove the turn: it became the FSM event's `utterance`, the complaint
 * callback's `payload.transcript`, and create_customer's
 * `sourceContext.transcript`, all persisted to the proposals table the owner
 * reviews (outside any retention purge). The caller's words are now scrubbed
 * once where they enter the turn, so nothing downstream sees the digits.
 */
function proposalHarness(classifierReply: Record<string, unknown>) {
  const provider: LLMProvider = {
    name: 'stub',
    isAvailable: async () => true,
    complete: async (): Promise<LLMResponse> => ({
      content: JSON.stringify(classifierReply),
      model: 'gpt-4o-mini',
      provider: 'openai',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    }),
  };
  const gateway = new LLMGateway({ defaultProvider: 'stub' }, new Map([['stub', provider]]));
  const store = new VoiceSessionStore({ startInterval: false });
  const proposalRepo = new InMemoryProposalRepository();
  const adapter = new TwilioGatherAdapter({
    store,
    gateway,
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    proposalRepo,
  });
  return { adapter, store, proposalRepo };
}

async function startKnownCall(h: ReturnType<typeof proposalHarness>, callSid: string) {
  await h.adapter.handleInbound({ callSid, from: '+15125550100', to: '+15125550999', tenantId: TENANT });
  const session = h.store.findByCallSid(callSid)!;
  if (session.machine.currentState === 'ask_caller') {
    session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
  }
  return session;
}

const COMPLAINT_SPOKEN = 'I was double charged on my card 4111 1111 1111 1111, I want a refund';
const COMPLAINT_STORED = 'I was double charged on my card [card number], I want a refund';

describe('PRIV-3 (review round 1) — a recited card number never reaches a stored proposal', () => {
  const complaint = { intentType: 'complaint', confidence: 0.97, reasoning: 'x' };

  it('Gather: the complaint callback proposal carries the marker, not the digits', async () => {
    const h = proposalHarness(complaint);
    const session = await startKnownCall(h, 'CA-pan-complaint-g');
    await h.adapter.handleGather({
      sessionId: session.id,
      callSid: 'CA-pan-complaint-g',
      speechResult: COMPLAINT_SPOKEN,
      confidence: 0.95,
      tenantId: TENANT,
    });
    const proposals = await h.proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect((proposals[0].payload as { transcript?: string }).transcript).toBe(COMPLAINT_STORED);
    expect(JSON.stringify(proposals)).not.toMatch(CARD_DIGITS);
  });

  it('Media Streams: the complaint callback proposal carries the marker, not the digits', async () => {
    const h = proposalHarness(complaint);
    const session = await startKnownCall(h, 'CA-pan-complaint-ms');
    await h.adapter.processCallerUtterance({
      sessionId: session.id,
      callSid: 'CA-pan-complaint-ms',
      speechResult: COMPLAINT_SPOKEN,
      tenantId: TENANT,
    });
    const proposals = await h.proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect((proposals[0].payload as { transcript?: string }).transcript).toBe(COMPLAINT_STORED);
    expect(JSON.stringify(proposals)).not.toMatch(CARD_DIGITS);
  });

  it("Gather: a new caller's sign-up proposal keeps the card out of its transcript and summary", async () => {
    const h = proposalHarness({
      intentType: 'create_customer',
      confidence: 0.97,
      extractedEntities: { displayName: 'Jane Doe' },
    });
    const session = await startKnownCall(h, 'CA-pan-signup-g');
    // The ask_caller turn created this record from the phone number, so the
    // sign-up (with their name) proceeds.
    session.callerCreatedThisCall = true;
    await h.adapter.handleGather({
      sessionId: session.id,
      callSid: 'CA-pan-signup-g',
      speechResult: 'hi this is Jane Doe, I want to set up an account, my card is 4111 1111 1111 1111',
      confidence: 0.95,
      tenantId: TENANT,
    });
    const proposals = await h.proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('create_customer');
    expect(proposals[0].sourceContext).toMatchObject({
      transcript: 'hi this is Jane Doe, I want to set up an account, my card is [card number]',
    });
    expect(JSON.stringify(proposals)).not.toMatch(CARD_DIGITS);
  });
});

describe('PRIV-3 (review round 1) — the shared voice-turn processor scrubs its own input', () => {
  // speechTurn is also driven directly (the text-mode quality driver, any
  // future transport), so it does not rely on its host having scrubbed.
  it('speechTurn: the complaint callback proposal carries the marker, not the digits', async () => {
    const provider: LLMProvider = {
      name: 'stub',
      isAvailable: async () => true,
      complete: async (): Promise<LLMResponse> => ({
        content: JSON.stringify({ intentType: 'complaint', confidence: 0.97, reasoning: 'x' }),
        model: 'gpt-4o-mini',
        provider: 'openai',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      }),
    };
    const gateway = new LLMGateway({ defaultProvider: 'stub' }, new Map([['stub', provider]]));
    const store = new VoiceSessionStore({ startInterval: false });
    const proposalRepo = new InMemoryProposalRepository();
    const processor = createVoiceTurnProcessor({
      store,
      gateway,
      businessName: 'Acme Plumbing',
      coverageSurface: 'gather',
      proposalRepo,
    });
    const callSid = 'CA-pan-processor';
    const session = store.create(TENANT, 'telephony', { callSid });
    session.machine.dispatch({ type: 'incoming_call', callSid, from: '+15125550100', to: '', tenantId: TENANT });
    session.machine.dispatch({ type: 'greeted_ok' });
    session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
    expect(session.machine.currentState).toBe('intent_capture');
    await processor.speechTurn({ session, speechResult: COMPLAINT_SPOKEN, callSid, tenantId: TENANT });
    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect((proposals[0].payload as { transcript?: string }).transcript).toBe(COMPLAINT_STORED);
    expect(JSON.stringify(proposals)).not.toMatch(CARD_DIGITS);
    expect(JSON.stringify(session.transcript)).not.toMatch(CARD_DIGITS);
  });
});
