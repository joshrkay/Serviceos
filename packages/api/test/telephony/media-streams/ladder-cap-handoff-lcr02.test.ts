/**
 * LCR-02 — the silence / low-STT / repeated-failure ladder on a stream call.
 *
 * Before: every cap (two silences, two low-confidence finals, two speechTurn
 * throws) spoke "Let me connect you with a team member" and hung up. Nothing
 * dispatched to the FSM, so nobody was paged and no <Dial> was ever parked.
 *
 * After, split on the CAPPING strike's cause:
 *   - the caller is speaking but we cannot serve them (low confidence, the
 *     turn pipeline throwing) → the FSM's `system_failure` through the host
 *     processor: notify_oncall parks a <Dial> (the "connect you" line is
 *     spoken only then), or the no-one-available message, or — nothing
 *     parked — a voicemail;
 *   - the line is silent → a voicemail, never a page.
 *
 * Production composition (real TwilioGatherAdapter as the turn host, the real
 * Twilio REST client), faking only the boundaries — same harness shape as
 * realtime-human-handoff.test.ts. Assertions are on what Twilio receives,
 * what the caller hears and the session's terminal stamp.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  TwilioMediaStreamAdapter,
  type MediaStreamAdapterDeps,
  type WsLike,
} from '../../../src/telephony/media-streams/mediastream-adapter';
import { TwilioGatherAdapter } from '../../../src/telephony/twilio-adapter';
import { DefaultTwilioCallControl } from '../../../src/telephony/twilio-call-control';
import { createTwilioCallRedirector } from '../../../src/telephony/twilio-call-redirect';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import type { VoiceSession } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryOnCallRepository, type OnCallEntry } from '../../../src/oncall/rotation';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import type {
  StreamingSession,
  StreamingTranscriptionProvider,
  StreamingTranscriptCallback,
  StreamingTranscriptEvent,
} from '../../../src/voice/transcription-providers';
import type { TtsProvider, TtsSynthesizeInput } from '../../../src/ai/tts/tts-provider';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

const TENANT = 'tenant-lcr02';
const PUBLIC_BASE_URL = 'https://api.test';
const TWILIO_API = 'https://twilio.test/2010-04-01';
const CALLER = '+15125550100';
const DISPATCHER = '+15125550101';

// Independent literals: what the caller must (never) hear.
const CONNECT_LINE = "I'm having trouble completing that. Let me connect you with a team member.";
const LOW_STT_REPROMPT = "I didn't quite catch that — could you say that again?";
const SILENCE_VOICEMAIL_LINE =
  "I haven't been able to hear you. If you still need help, please leave a message after the tone.";
const NO_HANDOFF_VOICEMAIL_LINE =
  "I'm sorry, I wasn't able to connect you to a team member. Please leave a message after the tone.";
const NO_ONE_AVAILABLE = "I'm sorry, no one is available right now.";

class FakeWs implements WsLike {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  closeCode: number | undefined;
  private acked = new Set<string>();
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
    this.fire('close');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): void {
    (this.listeners[event] ??= []).push(listener);
  }
  fire(event: string, ...args: unknown[]): void {
    for (const l of this.listeners[event] ?? []) l(...args);
  }
  inboundJson(obj: unknown): void {
    this.fire('message', JSON.stringify(obj));
  }
  markNames(): string[] {
    return this.sent.filter((f) => f.event === 'mark').map((f) => (f.mark as { name: string }).name);
  }
  /** Twilio echoing every outstanding mark = the queued audio finished playing. */
  ackAllMarks(streamSid: string): void {
    for (const name of this.markNames()) {
      if (this.acked.has(name)) continue;
      this.acked.add(name);
      this.inboundJson({ event: 'mark', streamSid, mark: { name } });
    }
  }
}

function makeStreamingProvider(): {
  provider: StreamingTranscriptionProvider;
  emit: (evt: StreamingTranscriptEvent) => void;
} {
  let cb: StreamingTranscriptCallback | null = null;
  const session: StreamingSession = { send: vi.fn(), finish: vi.fn(), destroy: vi.fn() };
  return {
    provider: {
      openSession: vi.fn((onEvent: StreamingTranscriptCallback) => {
        cb = onEvent;
        return Promise.resolve(session);
      }),
    },
    emit: (evt) => cb?.(evt),
  };
}

function makeGateway(): LLMGateway {
  const response: LLMResponse = {
    content: '{"intentType":"unknown","confidence":0,"reasoning":"x"}',
    model: 'mock',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as LLMGateway;
}

let callSeq = 0;

async function harness(opts: {
  /** On-call rotation; `[]` = nobody on call; `null` = no on-call repo wired. */
  rotation?: OnCallEntry[] | null;
  /** Replace the real turn host (the VOX-35c tests make it throw). */
  speechTurn?: MediaStreamAdapterDeps['speechTurn'];
  /** false = no REST redirector (PUBLIC_API_URL unset). */
  rest?: boolean;
} = {}) {
  const callSid = `CA-lcr02-${++callSeq}`;
  const streamSid = `MZ-lcr02-${callSeq}`;
  const store = new VoiceSessionStore({ startInterval: false });
  const auditRepo = new InMemoryAuditRepository();
  const rotation = opts.rotation === undefined ? [{ id: 'r1', userId: 'u1', orderIndex: 0 }] : opts.rotation;
  const gather = new TwilioGatherAdapter({
    store,
    gateway: makeGateway(),
    businessName: 'Acme Plumbing',
    publicBaseUrl: PUBLIC_BASE_URL,
    auditRepo,
    ...(rotation !== null
      ? {
          onCallRepo: new InMemoryOnCallRepository(new Map([[TENANT, rotation]])),
          callControl: new DefaultTwilioCallControl(),
          dispatcherPhoneResolver: async () => DISPATCHER,
        }
      : {}),
  });
  await gather.handleInboundForStream({ callSid, from: CALLER, tenantId: TENANT });
  const session = store.findByCallSid(callSid)!;

  const ws = new FakeWs();
  const restBodies: URLSearchParams[] = [];
  const restRedirect = createTwilioCallRedirector({
    resolveAuthToken: async () => 'tok_secret',
    defaultAccountSid: 'AC_deploy',
    publicBaseUrl: PUBLIC_BASE_URL,
    apiBaseUrl: TWILIO_API,
    fetchImpl: (async (_url: string, init: { body: string }) => {
      const body = new URLSearchParams(init.body);
      restBodies.push(body);
      // Twilio executing an accepted inline-TwiML update interrupts the stream.
      if (body.has('Twiml')) {
        setImmediate(() => {
          if (!ws.closed) ws.inboundJson({ event: 'stop', streamSid });
        });
      }
      return { ok: true, status: 200 };
    }) as unknown as typeof fetch,
  });
  const finalizeOnClose = vi.fn((s: VoiceSession, reason: string, fx: ReadonlyArray<SideEffect>) =>
    gather.finalizeTerminatedSession(s, fx, reason),
  );
  const deepgram = makeStreamingProvider();
  const spoken: string[] = [];
  const tts: TtsProvider = {
    synthesize: vi.fn(async (input: TtsSynthesizeInput) => {
      spoken.push(input.text);
      return { audio: Buffer.alloc(640), contentType: 'audio/pcm', provider: 'test' };
    }),
  };
  // Wired as app.ts wires attachMediaStreamServer.
  const deps: MediaStreamAdapterDeps = {
    store,
    streamingProvider: deepgram.provider,
    ttsProvider: tts,
    speechTurn:
      opts.speechTurn ??
      (({ session: s, speechResult, callSid: cs, tenantId }) =>
        gather.processCallerUtterance({ sessionId: s.id, callSid: cs, speechResult, tenantId })),
    finalizeOnClose,
    publicBaseUrl: PUBLIC_BASE_URL,
    setPendingTransferTwiml: gather.setPendingTransferTwiml.bind(gather),
    takePendingTransferTwiml: gather.takePendingTransferTwiml.bind(gather),
    deliverEscalationEffects: (s, fx, tenantId) => gather.deliverOutOfBandEffects(s, fx, tenantId),
    ladderVoicemailTwiml: (s, kind) => gather.buildLadderVoicemailTwiml(s, kind),
    silenceRepromptTimeoutMs: 40,
    handoffPlayoutMaxWaitMs: 200,
    handoffStreamEndWaitMs: 200,
    ...(opts.rest === false ? {} : { restRedirect }),
  } as MediaStreamAdapterDeps;
  const stream = new TwilioMediaStreamAdapter(deps, ws);
  stream.start();
  ws.inboundJson({
    event: 'start',
    streamSid,
    start: { callSid, accountSid: 'AC_start', streamSid, tracks: ['inbound'] },
  });
  await vi.waitFor(() => expect(deepgram.provider.openSession).toHaveBeenCalled());

  const mumble = (transcript: string) =>
    deepgram.emit({ type: 'final', transcript, confidence: 0.2, isFinal: true });
  const say = (transcript: string) =>
    deepgram.emit({ type: 'final', transcript, confidence: 0.95, isFinal: true });
  // TwiML text nodes are XML-escaped; compare against the words the caller hears.
  const transfers = () =>
    restBodies
      .filter((b) => b.has('Twiml'))
      .map((b) => b.get('Twiml')!.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  const escalationAudits = () => auditRepo.getAll().filter((e) => e.eventType.startsWith('escalation'));
  /** Keep acking every mark (each spoken line played) until `done` holds. */
  const playUntil = async (done: () => boolean) => {
    await vi.waitFor(
      () => {
        ws.ackAllMarks(streamSid);
        expect(done()).toBe(true);
      },
      { timeout: 3000, interval: 10 },
    );
  };

  return { callSid, streamSid, session, gather, ws, spoken, say, mumble, transfers, escalationAudits, finalizeOnClose, playUntil };
}

describe('LCR-02 stream ladder — the caller is speaking but cannot be served → the FSM escalation', () => {
  it('two low-confidence finals page on-call and transfer the call with the parked <Dial>', async () => {
    const h = await harness();

    h.mumble('mmuh');
    await vi.waitFor(() => expect(h.spoken).toContain(LOW_STT_REPROMPT));
    h.mumble('unh');

    await h.playUntil(() => h.transfers().length === 1);
    const twiml = h.transfers()[0];
    expect(twiml).toContain('<Dial');
    expect(twiml).toContain(DISPATCHER);
    // The promise is spoken only because a transfer really is being made.
    expect(h.spoken).toContain(CONNECT_LINE);
    expect(h.escalationAudits().length).toBeGreaterThan(0);
    expect(h.session.machine.currentState).toBe('escalating');
    // /dial-result owns the terminal stamp of a bridged call; the ladder never hung up.
    await vi.waitFor(() => expect(h.ws.closed).toBe(true));
    expect(h.finalizeOnClose).not.toHaveBeenCalled();
  });

  it('two speechTurn throws (VOX-35c) transfer the call with the parked <Dial> instead of hanging up', async () => {
    const speechTurn = vi.fn().mockRejectedValue(new Error('gateway down'));
    const h = await harness({ speechTurn });

    h.say('hello');
    await vi.waitFor(() => expect(speechTurn).toHaveBeenCalledTimes(1));
    await h.playUntil(() => h.spoken.length >= 1);
    h.say('anyone there');

    await h.playUntil(() => h.transfers().length === 1);
    expect(h.transfers()[0]).toContain('<Dial');
    expect(h.spoken).toContain(CONNECT_LINE);
    expect(h.session.machine.currentContext.escalationReason).toBe(
      'system_failure:speech_turn_repeated_failure',
    );
    expect(h.finalizeOnClose).not.toHaveBeenCalled();
  });

  it('nobody on call: the no-one-available message is delivered and "connect you" is never said', async () => {
    const h = await harness({ rotation: [] });

    h.mumble('mmuh');
    await vi.waitFor(() => expect(h.spoken).toContain(LOW_STT_REPROMPT));
    h.mumble('unh');

    await h.playUntil(() => h.transfers().length === 1);
    const twiml = h.transfers()[0];
    expect(twiml).not.toContain('<Dial');
    expect(twiml).toContain(NO_ONE_AVAILABLE);
    expect(h.spoken).not.toContain(CONNECT_LINE);
    await vi.waitFor(() => expect(h.finalizeOnClose).toHaveBeenCalled());
    expect(h.session.terminalReason).toBe('low_stt_confidence_max_retries');
  });

  it('nothing parked (no on-call wiring): a voicemail is offered, never the transfer promise', async () => {
    const h = await harness({ rotation: null });

    h.mumble('mmuh');
    await vi.waitFor(() => expect(h.spoken).toContain(LOW_STT_REPROMPT));
    h.mumble('unh');

    await h.playUntil(() => h.transfers().length === 1);
    const twiml = h.transfers()[0];
    expect(twiml).toContain('<Record');
    expect(twiml).toContain(NO_HANDOFF_VOICEMAIL_LINE);
    expect(twiml).toContain(`${PUBLIC_BASE_URL}/api/telephony/voicemail-status`);
    expect(h.spoken).not.toContain(CONNECT_LINE);
    await vi.waitFor(() => expect(h.finalizeOnClose).toHaveBeenCalled());
    expect(h.session.terminalReason).toBe('low_stt_confidence_max_retries');
  });

  it('no REST redirector: says honestly that nobody could be reached, waits for it to play, then ends', async () => {
    const h = await harness({ rest: false });

    h.mumble('mmuh');
    await vi.waitFor(() => expect(h.spoken).toContain(LOW_STT_REPROMPT));
    h.mumble('unh');

    await h.playUntil(() => h.ws.closed);
    expect(h.spoken).not.toContain(CONNECT_LINE);
    expect(h.spoken).toContain(
      "I'm sorry, I wasn't able to connect you to a team member. Please try calling again in a few minutes.",
    );
    expect(h.session.terminalReason).toBe('low_stt_confidence_max_retries');
  });
});

describe('LCR-02 stream ladder — a silent line → voicemail, never a page', () => {
  // The agent asks something; the caller's silence after it arms the timer.
  const agentAsks = async () => [{ type: 'tts_play' as const, payload: { text: 'How can I help you today?' } }];

  it('two silence expiries deliver a voicemail <Record>; on-call is not paged and no transfer is promised', async () => {
    const h = await harness({ speechTurn: agentAsks });

    // An agent turn plays; then the caller says nothing, twice.
    h.say('hello');
    await h.playUntil(() => h.spoken.includes(LOW_STT_REPROMPT));
    await h.playUntil(() => h.transfers().length === 1);

    const twiml = h.transfers()[0];
    expect(twiml).toContain('<Record');
    expect(twiml).not.toContain('<Dial');
    expect(twiml).toContain(SILENCE_VOICEMAIL_LINE);
    expect(h.spoken).not.toContain(CONNECT_LINE);
    expect(h.escalationAudits()).toHaveLength(0);
    expect(h.session.machine.currentState).not.toBe('escalating');
    await vi.waitFor(() => expect(h.finalizeOnClose).toHaveBeenCalled());
    expect(h.session.terminalReason).toBe('silence_max_retries');
  });

  it('a mumble then a silence caps on the silence: voicemail, no page', async () => {
    const h = await harness({ speechTurn: agentAsks });

    h.say('hello');
    await h.playUntil(() => h.spoken.length >= 1); // the agent's reply played
    h.mumble('mmuh');
    await vi.waitFor(() => expect(h.spoken).toContain(LOW_STT_REPROMPT));
    await h.playUntil(() => h.transfers().length === 1);

    expect(h.transfers()[0]).toContain('<Record');
    expect(h.escalationAudits()).toHaveLength(0);
    expect(h.spoken).not.toContain(CONNECT_LINE);
  });

  it('no REST redirector: a closing line that asks the caller to call back, then the leg ends', async () => {
    const h = await harness({ speechTurn: agentAsks, rest: false });

    h.say('hello');
    await h.playUntil(() => h.spoken.includes(LOW_STT_REPROMPT));
    await h.playUntil(() => h.ws.closed);

    expect(h.spoken).toContain(
      "I haven't been able to hear you, so I'll end the call here. Please call us back when you're ready.",
    );
    expect(h.spoken).not.toContain(CONNECT_LINE);
    expect(h.escalationAudits()).toHaveLength(0);
    expect(h.session.terminalReason).toBe('silence_max_retries');
  });
});
