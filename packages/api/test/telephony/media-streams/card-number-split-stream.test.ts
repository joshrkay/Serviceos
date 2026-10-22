/**
 * PRIV-3 follow-up — Media Streams: what the stream adapter reads after the
 * turn that completes a card number the caller split across turns.
 *
 * The turn host (`TwilioGatherAdapter#processCallerUtterance`, the shipped
 * `speechTurn` dep) appends the caller line, and the store rewrites it when it
 * completes a card split across turns. The adapter then fed its own copy of
 * the final, `event.transcript`, to the per-turn LLM sentiment check and the
 * vulnerability triage grade: the completing "1111" reached the provider in
 * the `call_sentiment` and `grade_vulnerability` requests. Production
 * composition (real gather adapter as the turn host, wired as app.ts wires
 * it), the REAL LLMGateway with a stubbed provider, and the sentiment and
 * vulnerability legs wired through it exactly as app.ts wires them.
 */
import { describe, expect, it, vi } from 'vitest';
import { TwilioMediaStreamAdapter, type WsLike } from '../../../src/telephony/media-streams/mediastream-adapter';
import { TwilioGatherAdapter } from '../../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { LLMGateway, type LLMProvider, type LLMRequest, type LLMResponse } from '../../../src/ai/gateway/gateway';
import { classifyTurnSentiment } from '../../../src/ai/agents/customer-calling/sentiment-classifier';
import { createVulnerabilityTriageHook } from '../../../src/ai/agents/customer-calling/vulnerability-triage-hook';
import { gradeVulnerability } from '../../../src/ai/agents/customer-calling/vulnerability-grader';
import { DEFAULT_ESCALATION_SETTINGS } from '../../../src/settings/settings';
import type {
  StreamingSession,
  StreamingTranscriptCallback,
  StreamingTranscriptEvent,
  StreamingTranscriptionProvider,
} from '../../../src/voice/transcription-providers';
import type { TtsProvider } from '../../../src/ai/tts/tts-provider';

const TENANT = 'tenant-pan-stream';
const CALL_SID = 'CA-pan-stream';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * True when `text` holds a group of the card's digits: its first part
 * ("4111 1111 ...") or a later "1111" on its own. Ids are set aside first (a
 * random uuid holds "1111" often enough to fail a suite), and a digit, not a
 * word boundary, bounds the "1111": in JSON a newline before it is "\\n1111".
 */
function holdsCardFragment(text: string): boolean {
  return /4111\D{0,3}1111|(?<!\d)1111(?!\d)/.test(text.replace(UUID, '<id>'));
}

function sentText(req: LLMRequest): string {
  return (req.messages ?? []).map((m) => String(m.content)).join('\n');
}

class FakeWs implements WsLike {
  sent: unknown[] = [];
  closed = false;
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
    this.fire('close');
  }
  on(event: string, listener: (...args: never[]) => void): void {
    (this.listeners[event] ??= []).push(listener);
  }
  fire(event: string, ...args: unknown[]): void {
    for (const l of this.listeners[event] ?? []) l(...args);
  }
  inboundJson(obj: unknown): void {
    this.fire('message', JSON.stringify(obj));
  }
}

function streamingProvider(): { provider: StreamingTranscriptionProvider; emit: (e: StreamingTranscriptEvent) => void } {
  let cb: StreamingTranscriptCallback | null = null;
  const session: StreamingSession = { send: vi.fn(), finish: vi.fn(), destroy: vi.fn() };
  return {
    provider: {
      openSession: vi.fn((onEvent: StreamingTranscriptCallback) => {
        cb = onEvent;
        return Promise.resolve(session);
      }),
    },
    emit: (e) => cb?.(e),
  };
}

const tts: TtsProvider = {
  synthesize: vi.fn(async () => ({ audio: Buffer.alloc(640), contentType: 'audio/pcm', provider: 'test' })),
};

function stubbedGateway() {
  const requests: LLMRequest[] = [];
  const provider: LLMProvider = {
    name: 'stub',
    isAvailable: async () => true,
    complete: async (req: LLMRequest): Promise<LLMResponse> => {
      requests.push(req);
      const content =
        req.taskType === 'call_sentiment'
          ? JSON.stringify({ frustrationScore: 0.1, reasonHint: 'calm' })
          : req.taskType === 'grade_vulnerability'
            ? JSON.stringify({ score: 0, factors: [], reasoning: 'none' })
            : (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent'
              ? JSON.stringify({ answer: 'no', reasoning: 'scripted' })
              : // A confident booking keeps the call taking turns (a second
                // "unknown" hands off, and an escalating call skips the reads).
                JSON.stringify({ intentType: 'create_appointment', confidence: 0.95, reasoning: 'x', extractedEntities: {} });
      return {
        content,
        model: 'gpt-4o-mini',
        provider: 'openai',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      };
    },
  };
  return { requests, gateway: new LLMGateway({ defaultProvider: 'stub' }, new Map([['stub', provider]])) };
}

describe('PRIV-3 — Media Streams: the post-turn LLM reads after a split card is completed', () => {
  it('the call_sentiment and grade_vulnerability requests carry the marker, never the completing digits', async () => {
    const { requests, gateway } = stubbedGateway();
    const store = new VoiceSessionStore({ startInterval: false });
    const gather = new TwilioGatherAdapter({
      store,
      gateway,
      businessName: 'Acme Plumbing',
      publicBaseUrl: 'https://example.com',
    });
    await gather.handleInboundForStream({ callSid: CALL_SID, from: '+15125550100', tenantId: TENANT });
    const session = store.findByCallSid(CALL_SID)!;
    // The greeting bootstrap (initializeStreamSession) is not driven here:
    // put the call where a known caller's request is taken.
    session.machine.dispatch({ type: 'incoming_call', callSid: CALL_SID, from: '+15125550100', to: '+15125550999', tenantId: TENANT });
    session.machine.dispatch({ type: 'greeted_ok' });
    session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
    expect(session.machine.currentState).toBe('intent_capture');

    const ws = new FakeWs();
    const deepgram = streamingProvider();
    const stream = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: deepgram.provider,
        ttsProvider: tts,
        // Wired as app.ts wires attachMediaStreamServer's speechTurn.
        speechTurn: ({ session: s, speechResult, callSid, tenantId, callerTiming, onCallerText }) =>
          gather.processCallerUtterance({
            sessionId: s.id,
            callSid,
            speechResult,
            tenantId,
            ...(callerTiming ? { callerTiming } : {}),
            ...(onCallerText ? { onCallerText } : {}),
          }),
        escalationSettings: { ...DEFAULT_ESCALATION_SETTINGS, trigger_llm_sentiment: true },
        sentimentClassifier: (input, budget) =>
          classifyTurnSentiment(input, {
            llm: {
              complete: async ({ prompt }: { prompt: string }) => {
                const res = await gateway.complete({
                  taskType: 'call_sentiment',
                  tenantId: input.tenantId,
                  messages: [{ role: 'user', content: prompt }],
                });
                return { text: res.content, tokenUsage: res.tokenUsage, model: res.model };
              },
            },
            ...budget,
          }),
        vulnerabilityTriageHook: createVulnerabilityTriageHook({
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
        }),
      },
      ws,
    );
    stream.start();
    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-pan-stream',
      start: { callSid: CALL_SID, accountSid: 'AC', streamSid: 'MZ-pan-stream', tracks: ['inbound'] },
    });
    await vi.waitFor(() => expect(deepgram.provider.openSession).toHaveBeenCalled());

    const postTurnReads = (): LLMRequest[] =>
      requests.filter((r) => r.taskType === 'call_sentiment' || r.taskType === 'grade_vulnerability');

    deepgram.emit({ type: 'final', transcript: 'my card is 4111 1111 1111', confidence: 0.95, isFinal: true });
    await vi.waitFor(() => expect(postTurnReads()).toHaveLength(2));
    const sentBefore = requests.length;

    deepgram.emit({ type: 'final', transcript: '1111', confidence: 0.95, isFinal: true });
    await vi.waitFor(() => expect(postTurnReads()).toHaveLength(4));

    // Everything the completing turn sent: its classification, then the
    // adapter's own post-turn reads of it.
    const completing = requests.slice(sentBefore);
    expect(completing.map((r) => r.taskType).sort()).toEqual(['call_sentiment', 'classify_intent', 'grade_vulnerability']);
    for (const req of completing) {
      const sent = sentText(req);
      expect(sent).toContain('[card number]');
      expect(holdsCardFragment(sent)).toBe(false);
    }
    expect(holdsCardFragment(session.transcript.join('\n'))).toBe(false);
    store.dispose();
  });
});
