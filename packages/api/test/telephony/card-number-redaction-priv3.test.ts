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

const TENANT = 'tenant-pan';
const SPOKEN = 'can I just pay now, my card is 4111 1111 1111 1111 expires 09/27';
const STORED = 'can I just pay now, my card is [card number] expires 09/27';

function harness() {
  const providerRequests: LLMRequest[] = [];
  const provider: LLMProvider = {
    name: 'stub',
    isAvailable: async () => true,
    complete: async (req: LLMRequest): Promise<LLMResponse> => {
      providerRequests.push(req);
      return {
        content: '{"intentType":"unknown","confidence":0,"reasoning":"x"}',
        model: 'gpt-4o-mini',
        provider: 'openai',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      };
    },
  };
  const gateway = new LLMGateway({ defaultProvider: 'stub' }, new Map([['stub', provider]]));
  const recordTurn = vi.fn(async () => undefined);
  const store = new VoiceSessionStore({
    startInterval: false,
    callTranscriptTurnRepo: { recordTurn } as never,
  });
  const adapter = new TwilioGatherAdapter({
    store,
    gateway,
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
  });
  return { adapter, store, recordTurn, providerRequests };
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
  expect(JSON.stringify(sessionTranscript)).not.toContain('4111');
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
});
