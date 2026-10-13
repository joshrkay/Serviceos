/**
 * Realtime (Media Streams) human hand-off delivery.
 *
 * A stream call is `<Connect><Stream>` with no follow-on verb, so a `<Dial>`
 * parked for "the next webhook response" is never read — there is no next
 * webhook on a stream call. These tests drive the PRODUCTION composition
 * (real TwilioGatherAdapter as the turn host, the real Twilio REST client from
 * `createTwilioCallRedirector`) and fake only the boundaries: the Twilio WS,
 * Deepgram, TTS and the HTTP `fetch` to api.twilio.com. Every assertion is on
 * an observable effect — the REST request Twilio would receive, the WS close,
 * the TwiML a webhook returns — never on an internal Map.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { createTelephonyRouter } from '../../../src/routes/telephony';
import {
  TwilioMediaStreamAdapter,
  type MediaStreamAdapterDeps,
  type WsLike,
} from '../../../src/telephony/media-streams/mediastream-adapter';
import { TwilioGatherAdapter } from '../../../src/telephony/twilio-adapter';
import { DefaultTwilioCallControl } from '../../../src/telephony/twilio-call-control';
import { createTwilioCallRedirector } from '../../../src/telephony/twilio-call-redirect';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryOnCallRepository, type OnCallEntry } from '../../../src/oncall/rotation';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import type {
  StreamingSession,
  StreamingTranscriptionProvider,
  StreamingTranscriptCallback,
  StreamingTranscriptEvent,
} from '../../../src/voice/transcription-providers';
import type { TtsProvider } from '../../../src/ai/tts/tts-provider';
import {
  HANDOFF_UNAVAILABLE_COPY,
  LOW_STT_CONFIDENCE_REPROMPT_COPY,
} from '../../../src/ai/agents/customer-calling/tts-copy';
import { patchOwnerThrough } from '../../../src/ai/skills/patch-owner-through';
import { WhisperCache } from '../../../src/telephony/whisper-cache';
import { DEFAULT_ESCALATION_SETTINGS, type SettingsRepository } from '../../../src/settings/settings';
import type { VoiceSession } from '../../../src/ai/agents/customer-calling/voice-session-store';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

const TENANT = 'tenant-handoff';
const PUBLIC_BASE_URL = 'https://api.test';
const TWILIO_API = 'https://twilio.test/2010-04-01';
const CALLER = '+15125550100';
const DISPATCHER = '+15125550101';
const START_ACCOUNT_SID = 'AC_start_frame';

// ─── Boundary fakes ──────────────────────────────────────────────────────────

class FakeWs implements WsLike {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  closeCode: number | undefined;
  closeReason: string | undefined;
  private acked = new Set<string>();
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    // Twilio answers a `clear` (barge-in) by echoing every outstanding mark.
    if (frame.event === 'clear') {
      const streamSid = String(frame.streamSid);
      setImmediate(() => this.ackAllMarks(streamSid));
    }
  }
  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
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
  /** Names of every `mark` frame the adapter has sent so far. */
  markNames(): string[] {
    return this.sent
      .filter((f) => f.event === 'mark')
      .map((f) => (f.mark as { name: string }).name);
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

/** `frames` × 20 ms of audio per line (1 = the line is enqueued at once). */
function makeTtsProvider(frames = 1): TtsProvider {
  return {
    synthesize: vi.fn(async () => ({
      audio: Buffer.alloc(640 * frames),
      contentType: 'audio/pcm',
      provider: 'test',
    })),
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

/** The fake api.twilio.com: records every Calls/{sid}.json update. */
function makeTwilioRest(respond: (body: URLSearchParams) => { ok: boolean; status: number } = () => ({ ok: true, status: 200 })) {
  const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => respond(new URLSearchParams(init.body)));
  return {
    fetchImpl,
    /** REST updates that carried inline TwiML (the hand-off). */
    transfers: () =>
      fetchImpl.mock.calls
        .map(([url, init]) => ({ url, body: new URLSearchParams(init.body) }))
        .filter((c) => c.body.has('Twiml')),
    /** REST updates that redirected the call to the Gather fallback webhook. */
    degrades: () =>
      fetchImpl.mock.calls
        .map(([url, init]) => ({ url, body: new URLSearchParams(init.body) }))
        .filter((c) => c.body.get('Url')?.endsWith('/api/telephony/voice/gather-fallback')),
  };
}

// ─── Production-shaped composition ───────────────────────────────────────────

let callSeq = 0;

async function harness(opts: {
  twilio?: ReturnType<typeof makeTwilioRest>;
  rotation?: OnCallEntry[];
  /** Replace the real turn host (for effects no production producer emits yet). */
  speechTurn?: ConstructorParameters<typeof TwilioMediaStreamAdapter>[0]['speechTurn'];
  /** The per-turn vulnerability triage hook (bound to the gather adapter). */
  vulnerabilityTriageHook?: (
    gather: TwilioGatherAdapter,
  ) => NonNullable<ConstructorParameters<typeof TwilioMediaStreamAdapter>[0]['vulnerabilityTriageHook']>;
  /** Tenant has LLM-sentiment escalation on; the classifier scores this. */
  llmFrustrationScore?: number;
  /** Further host deps, bound to the gather adapter. */
  extraDeps?: (gather: TwilioGatherAdapter) => Partial<MediaStreamAdapterDeps>;
  /**
   * Production ordering of an E1: runEmergencyScan awaits the tenant's
   * reviewed-script lookup BEFORE the FSM flips to `terminated`.
   */
  settingsLookupDelayMs?: number;
  /** Length of every spoken line, in 20 ms frames (long lines pace on mark acks). */
  ttsFrames?: number;
  /** The whisper cache the turn host stores dispatcher whispers in. */
  whisperCache?: WhisperCache;
} = {}) {
  const callSid = `CA-handoff-${++callSeq}`;
  const streamSid = `MZ-handoff-${callSeq}`;
  const store = new VoiceSessionStore({ startInterval: false });
  const auditRepo = new InMemoryAuditRepository();
  const gather = new TwilioGatherAdapter({
    store,
    gateway: makeGateway(),
    businessName: 'Acme Plumbing',
    publicBaseUrl: PUBLIC_BASE_URL,
    onCallRepo: new InMemoryOnCallRepository(
      new Map([[TENANT, opts.rotation ?? [{ id: 'r1', userId: 'u1', orderIndex: 0 }]]]),
    ),
    auditRepo,
    callControl: new DefaultTwilioCallControl(),
    dispatcherPhoneResolver: async () => DISPATCHER,
    ...(opts.whisperCache ? { whisperCache: opts.whisperCache } : {}),
    ...(opts.settingsLookupDelayMs !== undefined
      ? {
          settingsRepo: {
            findByTenant: async () => {
              await new Promise((r) => setTimeout(r, opts.settingsLookupDelayMs));
              return null;
            },
          } as unknown as SettingsRepository,
        }
      : {}),
  });
  await gather.handleInboundForStream({ callSid, from: CALLER, tenantId: TENANT });
  const session = store.findByCallSid(callSid)!;

  const twilio = opts.twilio ?? makeTwilioRest();
  const restRedirect = createTwilioCallRedirector({
    resolveAuthToken: async () => 'tok_secret',
    defaultAccountSid: 'AC_deploy',
    publicBaseUrl: PUBLIC_BASE_URL,
    apiBaseUrl: TWILIO_API,
    fetchImpl: twilio.fetchImpl as unknown as typeof fetch,
  });
  const finalizeOnClose = vi.fn((s, reason: string, fx) => gather.finalizeTerminatedSession(s, fx, reason));
  const deepgram = makeStreamingProvider();
  const ws = new FakeWs();
  const tts = makeTtsProvider(opts.ttsFrames);
  // Wired exactly as app.ts wires attachMediaStreamServer.
  const stream = new TwilioMediaStreamAdapter(
    {
      store,
      streamingProvider: deepgram.provider,
      ttsProvider: tts,
      speechTurn:
        opts.speechTurn ??
        (({ session: s, speechResult, callSid: cs, tenantId }) =>
          gather.processCallerUtterance({ sessionId: s.id, callSid: cs, speechResult, tenantId })),
      callControl: new DefaultTwilioCallControl(),
      ...(opts.vulnerabilityTriageHook
        ? { vulnerabilityTriageHook: opts.vulnerabilityTriageHook(gather) }
        : {}),
      ...(opts.llmFrustrationScore !== undefined
        ? {
            escalationSettings: { ...DEFAULT_ESCALATION_SETTINGS, trigger_llm_sentiment: true },
            sentimentClassifier: async () => ({ frustrationScore: opts.llmFrustrationScore! }),
            deliverEscalationEffects: (s: VoiceSession, fx: SideEffect[], tenantId: string) =>
              gather.deliverOutOfBandEffects(s, fx, tenantId),
          }
        : {}),
      interimEmergencyScan: ({ session: s, speechResult, tenantId }) =>
        gather.scanInterimForEmergency({ sessionId: s.id, speechResult, tenantId }),
      finalizeOnClose,
      publicBaseUrl: PUBLIC_BASE_URL,
      setPendingTransferTwiml: gather.setPendingTransferTwiml.bind(gather),
      takePendingTransferTwiml: gather.takePendingTransferTwiml.bind(gather),
      restRedirect,
      ...(opts.extraDeps ? opts.extraDeps(gather) : {}),
    },
    ws,
  );
  stream.start();
  ws.inboundJson({
    event: 'start',
    streamSid,
    start: { callSid, accountSid: START_ACCOUNT_SID, streamSid, tracks: ['inbound'] },
  });
  await vi.waitFor(() => expect(deepgram.provider.openSession).toHaveBeenCalled());

  const say = (transcript: string) =>
    deepgram.emit({ type: 'final', transcript, confidence: 0.95, isFinal: true });

  return { callSid, streamSid, store, session, gather, twilio, ws, deepgram, tts, say, finalizeOnClose, auditRepo };
}

// ─── (a) escalation on a stream call is delivered to Twilio ──────────────────

describe('realtime hand-off — escalation on a stream call reaches a human', () => {
  it('issues the REST transfer with the Dial TwiML only after the "connecting you" line has played', async () => {
    const h = await harness();

    h.say('I want to speak to a person');

    // The spoken hand-off line is queued (its end-of-utterance mark is out)…
    await vi.waitFor(() => expect(h.ws.markNames().some((n) => n.startsWith('silence-arm-'))).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    // …but the call is not pulled off the stream while the caller is still hearing it.
    expect(h.twilio.transfers()).toHaveLength(0);

    // Twilio reports the line finished playing.
    h.ws.ackAllMarks(h.streamSid);

    await vi.waitFor(() => expect(h.twilio.transfers()).toHaveLength(1));
    const [transfer] = h.twilio.transfers();
    // Same account resolution as the WS7 degrade: the start frame's AccountSid.
    expect(transfer.url).toBe(`${TWILIO_API}/Accounts/${START_ACCOUNT_SID}/Calls/${h.callSid}.json`);
    const twiml = transfer.body.get('Twiml')!;
    expect(twiml).toContain('<Dial');
    expect(twiml).toContain(DISPATCHER);
    expect(twiml).toContain(
      `action="${PUBLIC_BASE_URL}/api/telephony/dial-result?sid=${encodeURIComponent(h.session.id)}"`,
    );

    // The stream leg is released cleanly; the Dial's /dial-result owns the
    // session's terminal stamp (ended_reason 'transferred' on answer), so the
    // close does NOT finalize the session here.
    await vi.waitFor(() => expect(h.ws.closed).toBe(true));
    expect(h.ws.closeCode).toBe(1000);
    expect(h.finalizeOnClose).not.toHaveBeenCalled();
    expect(h.session.terminalOutcome).toBeUndefined();
  });

  it("the delivered Dial's whisper screen is tied to this session (H1: its press-1 marks THIS hand-off)", async () => {
    const whisperCache = new WhisperCache();
    const h = await harness({ whisperCache });

    h.say('I want to speak to a person');
    await vi.waitFor(() => expect(h.ws.markNames().some((n) => n.startsWith('silence-arm-'))).toBe(true));
    h.ws.ackAllMarks(h.streamSid);
    await vi.waitFor(() => expect(h.twilio.transfers()).toHaveLength(1));

    const twiml = h.twilio.transfers()[0].body.get('Twiml')!;
    const escalationId = /\/api\/telephony\/whisper\/([^"]+)" method="GET"/.exec(twiml)?.[1];
    expect(escalationId).toBeDefined();
    expect(whisperCache.get(escalationId!)).toMatchObject({ tenantId: TENANT, sessionId: h.session.id });
  });

  it('Twilio ending the stream while the transfer request is in flight is not stamped as a hang-up', async () => {
    // Twilio stops the <Stream> (stop frame + socket close) as soon as it
    // starts executing the new TwiML — often before our REST response lands.
    let accept!: (r: { ok: boolean; status: number }) => void;
    const twilio = makeTwilioRest();
    twilio.fetchImpl.mockImplementationOnce(
      () => new Promise<{ ok: boolean; status: number }>((resolve) => { accept = resolve; }),
    );
    const h = await harness({ twilio });

    h.say('I want to speak to a person');
    await vi.waitFor(() => expect(h.ws.markNames().some((n) => n.startsWith('silence-arm-'))).toBe(true));
    h.ws.ackAllMarks(h.streamSid);
    await vi.waitFor(() => expect(h.twilio.transfers()).toHaveLength(1));

    h.ws.inboundJson({ event: 'stop', streamSid: h.streamSid });
    await new Promise((r) => setTimeout(r, 10));
    accept({ ok: true, status: 200 });
    await new Promise((r) => setTimeout(r, 10));

    // /dial-result — not this close — stamps the transferred call.
    expect(h.finalizeOnClose).not.toHaveBeenCalled();
    expect(h.session.terminalOutcome).toBeUndefined();
  });

  it('caller silence while the transfer is in flight never triggers a reprompt over it', async () => {
    let accept!: (r: { ok: boolean; status: number }) => void;
    const twilio = makeTwilioRest();
    twilio.fetchImpl.mockImplementationOnce(
      () => new Promise<{ ok: boolean; status: number }>((resolve) => { accept = resolve; }),
    );
    const h = await harness({ twilio, extraDeps: () => ({ silenceRepromptTimeoutMs: 20 }) });
    const spoken = () =>
      (h.tts.synthesize as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => (input as { text: string }).text);

    h.say('I want to speak to a person');
    await vi.waitFor(() => expect(h.ws.markNames().some((n) => n.startsWith('silence-arm-'))).toBe(true));
    const linesBefore = spoken().length;
    h.ws.ackAllMarks(h.streamSid);
    await vi.waitFor(() => expect(h.twilio.transfers()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 80)); // the silence window passes mid-transfer

    expect(spoken()).toHaveLength(linesBefore);
    accept({ ok: true, status: 200 });
    await vi.waitFor(() => expect(h.ws.closed).toBe(true));
  });

  it('an E2 emergency caught on an INTERIM transcript is transferred to the dispatcher', async () => {
    const h = await harness();

    // Interims precede finals, so the interim scan is where E2 usually fires.
    h.deepgram.emit({
      type: 'partial',
      transcript: 'my basement is flooding',
      confidence: 0.9,
      isFinal: false,
    });
    await vi.waitFor(() => expect(h.ws.markNames().some((n) => n.startsWith('silence-arm-'))).toBe(true));
    h.ws.ackAllMarks(h.streamSid);

    await vi.waitFor(() => expect(h.twilio.transfers()).toHaveLength(1));
    const twiml = h.twilio.transfers()[0].body.get('Twiml')!;
    expect(twiml).toContain('<Dial');
    expect(twiml).toContain(DISPATCHER);
    await vi.waitFor(() => expect(h.ws.closed).toBe(true));
  });
});

// ─── (c) the Dial's no-answer cascade lands on a route that exists ───────────

describe('realtime hand-off — escalate_with_context', () => {
  it('builds the Dial action as /api/telephony/dial-result?sid=<session> (the route that cascades no-answer)', async () => {
    let sessionId = '';
    const h = await harness({
      speechTurn: async ({ session, callSid, tenantId }) => {
        sessionId = session.id;
        return [
          { type: 'tts_play', payload: { text: 'Connecting you now.' } },
          {
            type: 'escalate_with_context',
            payload: {
              escalationId: 'esc_ctx',
              summary: {
                whisper: 'Caller needs help.',
                sms: 'Escalation <escalationId>',
                panel: {
                  header: { title: 'Escalation', callerName: 'Sam', callerPhone: CALLER },
                  customer: { name: 'Sam', phone: CALLER, tags: [] },
                  lastInteraction: null,
                  intent: { summary: 'wants a person', entities: [] },
                  reason: { code: 'operator_request', humanReadable: 'asked for a person' },
                  transcriptSnapshot: [],
                },
              },
              dispatcher: { userId: 'u1', phone: DISPATCHER },
              callSid,
              tenantId,
              channelPreferences: { sms: false, in_app: false, whisper: false },
            },
          },
        ];
      },
    });

    h.say('get me a person');
    await vi.waitFor(() => expect(h.ws.markNames().some((n) => n.startsWith('silence-arm-'))).toBe(true));
    h.ws.ackAllMarks(h.streamSid);

    await vi.waitFor(() => expect(h.twilio.transfers()).toHaveLength(1));
    const twiml = h.twilio.transfers()[0].body.get('Twiml')!;
    expect(twiml).toContain(
      `action="${PUBLIC_BASE_URL}/api/telephony/dial-result?sid=${encodeURIComponent(sessionId)}"`,
    );
    expect(twiml).not.toContain('/api/telephony/dial-action');
  });
});

// ─── (e) one hand-off per call ───────────────────────────────────────────────

describe('realtime hand-off — idempotency', () => {
  it('a second escalation turn while the first hand-off is pending never issues a second transfer', async () => {
    const DIAL_A = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial action="${PUBLIC_BASE_URL}/api/telephony/dial-result?sid=x"><Number>+15125550111</Number></Dial></Response>`;
    const DIAL_B = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial action="${PUBLIC_BASE_URL}/api/telephony/dial-result?sid=x"><Number>+15125550222</Number></Dial></Response>`;
    const parked = [DIAL_A, DIAL_B];
    let gatherRef: TwilioGatherAdapter | undefined;
    const h = await harness({
      // Each turn escalates and parks its own Dial (e.g. two immediate
      // emergency dials walking the rotation), as the real producers do.
      speechTurn: async ({ session }) => {
        gatherRef!.setPendingTransferTwiml(session.id, parked.shift()!);
        return [{ type: 'tts_play', payload: { text: 'Connecting you now.' } }];
      },
    });
    gatherRef = h.gather;

    h.say('gas is fine but the pipe burst');
    await vi.waitFor(() => expect(h.ws.markNames().filter((n) => n.startsWith('silence-arm-'))).toHaveLength(1));
    h.say('please hurry, the pipe burst');
    await vi.waitFor(() => expect(h.ws.markNames().filter((n) => n.startsWith('silence-arm-'))).toHaveLength(2));
    h.ws.ackAllMarks(h.streamSid);

    await vi.waitFor(() => expect(h.ws.closed).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(h.twilio.transfers()).toHaveLength(1);
    expect(h.twilio.transfers()[0].body.get('Twiml')).toBe(DIAL_A);
  });
});

// ─── (f) vulnerable-caller owner patch ───────────────────────────────────────

describe('realtime hand-off — vulnerable-caller owner patch', () => {
  it('the owner patch parked by the post-turn triage hook is delivered to the live call', async () => {
    const OWNER = '+15125550177';
    const h = await harness({
      speechTurn: async () => [{ type: 'tts_play', payload: { text: 'I can help with that.' } }],
      // As app.ts's onPatchOwner: the real patchOwnerThrough builds the
      // announce + <Dial>, parked on the gather adapter's shared Map.
      vulnerabilityTriageHook: (gather) => async ({ session, tenantId }) => {
        const result = await patchOwnerThrough(
          {
            tenantId,
            sessionId: session.id,
            ...(session.callSid ? { callSid: session.callSid } : {}),
            dialActionUrl: `${PUBLIC_BASE_URL}/api/telephony/dial-result?sid=${encodeURIComponent(session.id)}`,
            reason: 'elderly caller, no heat',
            shopName: 'Acme Plumbing',
          },
          { callControl: new DefaultTwilioCallControl(), ownerPhoneResolver: async () => OWNER },
        );
        if (result.kind === 'bridged') gather.setPendingTransferTwiml(session.id, result.twiml);
      },
    });

    h.say("my mother is 90 and the heat is out");
    await vi.waitFor(() => expect(h.ws.markNames().some((n) => n.startsWith('silence-arm-'))).toBe(true));
    h.ws.ackAllMarks(h.streamSid);

    await vi.waitFor(() => expect(h.twilio.transfers()).toHaveLength(1));
    const twiml = h.twilio.transfers()[0].body.get('Twiml')!;
    expect(twiml).toMatch(/<Response><Say[^>]*>[^<]+<\/Say><Dial/);
    expect(twiml).toContain(OWNER);
    await vi.waitFor(() => expect(h.ws.closed).toBe(true));
  });
});

describe('realtime hand-off — LLM-sentiment frustration', () => {
  it('the out-of-band frustration escalation (classifier fires after the turn) is transferred', async () => {
    const h = await harness({
      speechTurn: async () => [{ type: 'tts_play', payload: { text: 'Let me look into that.' } }],
      llmFrustrationScore: 0.95,
    });

    h.say('this has been going on for three days and nobody calls me back');
    // The turn's reply, then the reassurance line from the sentiment escalation.
    await vi.waitFor(() => expect(h.ws.markNames().filter((n) => n.startsWith('silence-arm-'))).toHaveLength(2));
    h.ws.ackAllMarks(h.streamSid);

    await vi.waitFor(() => expect(h.twilio.transfers()).toHaveLength(1));
    expect(h.twilio.transfers()[0].body.get('Twiml')).toContain(DISPATCHER);
  });
});

const PARKED_DIAL = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial action="${PUBLIC_BASE_URL}/api/telephony/dial-result?sid=s"><Number>${DISPATCHER}</Number></Dial></Response>`;

describe('realtime hand-off — escalations outside a caller turn', () => {
  it('a hand-off parked during session bootstrap (identity hand-off) is delivered after the greeting plays', async () => {
    const h = await harness({
      extraDeps: (gather) => ({
        initializeSession: async ({ callSid }) => {
          gather.setPendingTransferTwiml(h0SessionId(gather, callSid), PARKED_DIAL);
          return [{ type: 'tts_play', payload: { text: 'Thanks for calling. Let me get someone for you.' } }];
        },
      }),
    });

    await vi.waitFor(() => expect(h.ws.markNames().some((n) => n.startsWith('silence-arm-'))).toBe(true));
    h.ws.ackAllMarks(h.streamSid);

    await vi.waitFor(() => expect(h.twilio.transfers()).toHaveLength(1));
    expect(h.twilio.transfers()[0].body.get('Twiml')).toBe(PARKED_DIAL);
  });

  it('a hand-off parked by the silence-timer pending-dialogue handler is delivered', async () => {
    const h = await harness({
      speechTurn: async () => [{ type: 'tts_play', payload: { text: 'Shall I go ahead?' } }],
      extraDeps: (gather) => ({
        silenceRepromptTimeoutMs: 20,
        handlePendingDialogueSilence: async (session) => {
          gather.setPendingTransferTwiml(session.id, PARKED_DIAL);
          return [{ type: 'tts_play', payload: { text: 'Let me get someone on the line.' } }];
        },
      }),
    });

    h.say('approve it');
    await vi.waitFor(() => expect(h.ws.markNames().filter((n) => n.startsWith('silence-arm-'))).toHaveLength(1));
    h.ws.ackAllMarks(h.streamSid); // the question played; the caller stays silent
    await vi.waitFor(() => expect(h.ws.markNames().filter((n) => n.startsWith('silence-arm-'))).toHaveLength(2));
    h.ws.ackAllMarks(h.streamSid);

    await vi.waitFor(() => expect(h.twilio.transfers()).toHaveLength(1));
    expect(h.twilio.transfers()[0].body.get('Twiml')).toBe(PARKED_DIAL);
  });
});

// ─── (h) E1 on an interim transcript ends the call ───────────────────────────

describe('E1 life-safety on an INTERIM transcript', () => {
  it('closes the call once the 911 script has played, stamped life_safety_e1, with no reprompt after it', async () => {
    const h = await harness({ extraDeps: () => ({ silenceRepromptTimeoutMs: 20 }) });
    const spoken = () =>
      (h.tts.synthesize as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => (input as { text: string }).text);

    h.deepgram.emit({ type: 'partial', transcript: 'I smell gas in the kitchen', confidence: 0.9, isFinal: false });
    await vi.waitFor(() => expect(h.ws.markNames().some((n) => n.startsWith('silence-arm-'))).toBe(true));
    const scriptLines = spoken().length;
    expect(scriptLines).toBeGreaterThan(0);

    h.ws.ackAllMarks(h.streamSid); // the evacuation script finished playing
    await new Promise((r) => setTimeout(r, 80)); // well past the silence window

    expect(h.ws.closed).toBe(true);
    expect(h.session.terminalReason).toBe('life_safety_e1');
    expect(spoken()).not.toContain(LOW_STT_CONFIDENCE_REPROMPT_COPY);
    expect(spoken()).toHaveLength(scriptLines);
  });

  it('M2 — an E1 on a FINAL transcript closes only after the 911 script has played (no truncated tail)', async () => {
    const h = await harness();

    h.say('I smell gas in the kitchen');
    await vi.waitFor(() => expect(h.session.machine.currentState).toBe('terminated'));
    await vi.waitFor(() => expect(h.ws.markNames().some((n) => n.startsWith('silence-arm-'))).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    // Closing the stream now would drop the unplayed end of the script.
    expect(h.ws.closed).toBe(false);

    h.ws.ackAllMarks(h.streamSid); // Twilio played it all
    await vi.waitFor(() => expect(h.ws.closed).toBe(true));
    expect(h.session.terminalReason).toBe('life_safety_e1');
  });

  it('the silence ladder never reprompts once the FSM has terminated, even if the leg is still open', async () => {
    const h = await harness({
      extraDeps: () => ({ silenceRepromptTimeoutMs: 20 }),
      // A host path that ends the conversation (FSM → terminated) but hands
      // back no end_session — the shape the post-E1 final transcript has.
      speechTurn: async ({ session }) => {
        session.machine.dispatch({
          type: 'emergency_detected',
          keyword: 'gas',
          utterance: 'I smell gas',
          tier: 'E1',
        });
        return [{ type: 'tts_play', payload: { text: 'Leave the house now and call 911 from outside.' } }];
      },
    });
    const spoken = () =>
      (h.tts.synthesize as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => (input as { text: string }).text);

    h.say('I smell gas');
    await vi.waitFor(() => expect(h.ws.markNames().some((n) => n.startsWith('silence-arm-'))).toBe(true));
    expect(h.session.machine.currentState).toBe('terminated');
    h.ws.ackAllMarks(h.streamSid);
    await new Promise((r) => setTimeout(r, 80)); // well past the silence window

    expect(spoken()).toEqual(['Leave the house now and call 911 from outside.']);
  });
});

/** The session the bootstrap runs for (created by handleInboundForStream). */
function h0SessionId(gather: TwilioGatherAdapter, callSid: string): string {
  return gather.getDeps().store.findByCallSid(callSid)!.id;
}

describe('realtime hand-off — an E1 life-safety close supersedes a pending transfer', () => {
  it('a hazard reported while the hand-off line plays cancels the Dial (E1 never bridges)', async () => {
    let releaseE1Turn!: () => void;
    let turn = 0;
    const h = await harness({
      speechTurn: async ({ session }) => {
        turn += 1;
        if (turn === 1) {
          session.machine.dispatch({ type: 'frustration_detected', source: 'keyword', detail: 'real person' });
          // (as handleNotifyOncall does)
          h.gather.setPendingTransferTwiml(session.id, PARKED_DIAL_FOR_E1);
          return [{ type: 'tts_play', payload: { text: 'Let me get a person on the line.' } }];
        }
        // "…and I smell gas": the FSM terminates at dispatch, before the E1
        // turn's bounded audit write lets it return its script.
        session.machine.dispatch({ type: 'emergency_detected', keyword: 'gas', utterance: 'I smell gas', tier: 'E1' });
        await new Promise<void>((resolve) => { releaseE1Turn = resolve; });
        return [
          { type: 'tts_play', payload: { text: 'Leave the house now and call 911 from outside.' } },
          { type: 'end_session', payload: { reason: 'life_safety_e1' } },
        ];
      },
    });

    h.say('I want a real person');
    await vi.waitFor(() => expect(h.ws.markNames().some((n) => n.startsWith('silence-arm-'))).toBe(true));
    h.say('and I smell gas');
    await vi.waitFor(() => expect(h.session.machine.currentState).toBe('terminated'));
    h.ws.ackAllMarks(h.streamSid); // the hand-off line finished mid-E1-turn
    await new Promise((r) => setTimeout(r, 30));
    releaseE1Turn();
    // The 911 script plays out before the leg closes (M2).
    await vi.waitFor(() => expect(h.ws.markNames().filter((n) => n.startsWith('silence-arm-'))).toHaveLength(2));
    h.ws.ackAllMarks(h.streamSid);
    await vi.waitFor(() => expect(h.ws.closed).toBe(true));

    expect(h.twilio.transfers()).toHaveLength(0);
  });
});

/**
 * C1 (review of #1676) — PRODUCTION ordering. The E1 scan awaits the tenant's
 * reviewed-script lookup BEFORE the FSM flips to `terminated`, and the
 * hand-off takes no session lock, so a point-in-time FSM read lost the race.
 */
describe('realtime hand-off — E1 with production ordering (await before the FSM flips)', () => {
  /** Keep echoing marks (= Twilio playing whatever is queued) until stopped. */
  function playEverything(h: Awaited<ReturnType<typeof harness>>) {
    const pump = setInterval(() => h.ws.ackAllMarks(h.streamSid), 10);
    return () => clearInterval(pump);
  }
  const spokenOf = (h: Awaited<ReturnType<typeof harness>>) =>
    (h.tts.synthesize as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => (input as { text: string }).text);

  it('barge-in: "I smell gas" over the hand-off line → the 911 script plays, no transfer (30 ms lookup)', async () => {
    const h = await harness({ settingsLookupDelayMs: 30, ttsFrames: 200 });

    h.say('I want to speak to a person');
    // The hand-off line is mid-stream, paced on (unacked) marks.
    await vi.waitFor(() =>
      expect(h.ws.markNames().filter((n) => n.startsWith('turn-')).length).toBeGreaterThanOrEqual(3),
    );
    h.deepgram.emit({ type: 'partial', transcript: 'I smell gas', confidence: 0.9, isFinal: false });

    const stop = playEverything(h);
    try {
      await vi.waitFor(() => expect(h.ws.closed).toBe(true), { timeout: 4_000 });
    } finally {
      stop();
    }
    expect(h.twilio.transfers()).toHaveLength(0);
    expect(h.session.terminalReason).toBe('life_safety_e1');
    expect(spokenOf(h).some((t) => t.includes('call 911'))).toBe(true);
  });

  it('no barge-in: the line finishes while the E1 lookup (300 ms) is still in flight → no transfer', async () => {
    const h = await harness({ settingsLookupDelayMs: 300 });

    h.say('I want to speak to a person');
    await vi.waitFor(() => expect(h.ws.markNames().some((n) => n.startsWith('silence-arm-'))).toBe(true));
    h.deepgram.emit({ type: 'partial', transcript: 'I smell gas', confidence: 0.9, isFinal: false });
    await new Promise((r) => setTimeout(r, 20));

    const stop = playEverything(h);
    try {
      await vi.waitFor(() => expect(h.ws.closed).toBe(true), { timeout: 4_000 });
    } finally {
      stop();
    }
    expect(h.twilio.transfers()).toHaveLength(0);
    expect(h.session.terminalReason).toBe('life_safety_e1');
  });

  it('backstop: E1 while the transfer is in flight → a corrective update speaks the 911 script and hangs up', async () => {
    let accept!: (r: { ok: boolean; status: number }) => void;
    const twilio = makeTwilioRest();
    twilio.fetchImpl.mockImplementationOnce(
      () => new Promise<{ ok: boolean; status: number }>((resolve) => { accept = resolve; }),
    );
    const h = await harness({ twilio });

    h.say('I want to speak to a person');
    await vi.waitFor(() => expect(h.ws.markNames().some((n) => n.startsWith('silence-arm-'))).toBe(true));
    h.ws.ackAllMarks(h.streamSid);
    await vi.waitFor(() => expect(h.twilio.transfers()).toHaveLength(1)); // the Dial is in flight

    h.deepgram.emit({ type: 'partial', transcript: 'I smell gas', confidence: 0.9, isFinal: false });
    await vi.waitFor(() => expect(h.session.machine.currentState).toBe('terminated'));
    accept({ ok: true, status: 200 }); // Twilio had already applied the Dial

    await vi.waitFor(() => expect(h.twilio.transfers()).toHaveLength(2));
    const corrective = h.twilio.transfers()[1].body.get('Twiml')!;
    expect(corrective).toContain('call 911');
    expect(corrective).toContain('<Hangup/>');
    expect(corrective).not.toContain('<Dial');
    await vi.waitFor(() => expect(h.session.terminalReason).toBe('life_safety_e1'));
  });
});

const PARKED_DIAL_FOR_E1 =`<?xml version="1.0" encoding="UTF-8"?><Response><Dial action="${PUBLIC_BASE_URL}/api/telephony/dial-result?sid=s"><Number>${DISPATCHER}</Number></Dial></Response>`;

// ─── (d) the Gather transport keeps its own delivery ─────────────────────────

describe('Gather transport — hand-off delivery unchanged', () => {
  it('an escalating /gather turn returns the Dial in the webhook response; no REST update is involved', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const gather = new TwilioGatherAdapter({
      store,
      gateway: makeGateway(),
      businessName: 'Acme Plumbing',
      publicBaseUrl: PUBLIC_BASE_URL,
      onCallRepo: new InMemoryOnCallRepository(
        new Map([[TENANT, [{ id: 'r1', userId: 'u1', orderIndex: 0 }]]]),
      ),
      auditRepo: new InMemoryAuditRepository(),
      callControl: new DefaultTwilioCallControl(),
      dispatcherPhoneResolver: async () => DISPATCHER,
    });
    const app = express();
    app.use(
      '/api/telephony',
      createTelephonyRouter({
        adapter: gather,
        authTokenGetter: () => WEBHOOK_TOKEN,
        publicBaseUrl: PUBLIC_BASE_URL,
        resolveTenantId: () => TENANT,
        voiceSessionStore: store,
      }),
    );
    await gather.handleInbound({ callSid: 'CA-gather-1', from: CALLER, to: '+15125550999', tenantId: TENANT });
    const session = store.findByCallSid('CA-gather-1')!;

    const res = await signedPost(app, `/api/telephony/gather?sid=${session.id}`, {
      CallSid: 'CA-gather-1',
      SpeechResult: 'I want to speak to a person',
      Confidence: '0.95',
      From: CALLER,
      To: '+15125550999',
    });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Dial');
    expect(res.text).toContain(DISPATCHER);
    expect(res.text).toContain(
      `action="${PUBLIC_BASE_URL}/api/telephony/dial-result?sid=${encodeURIComponent(session.id)}"`,
    );
    expect(res.text).not.toContain('<Gather');
    // The webhook response consumed the parked hand-off — nothing is left for
    // any other consumer to deliver a second time.
    expect(gather.takePendingTransferTwiml(session.id)).toBeUndefined();
  });
});

// ─── (b) a refused transfer never leaves the caller in dead air ──────────────

const WEBHOOK_TOKEN = 'webhook-token';

function signedPost(app: express.Application, path: string, params: Record<string, string>) {
  const sig = twilio.getExpectedTwilioSignature(WEBHOOK_TOKEN, `${PUBLIC_BASE_URL}${path}`, params);
  return request(app).post(path).set('X-Twilio-Signature', sig).type('form').send(params);
}

function telephonyApp(h: Awaited<ReturnType<typeof harness>>) {
  const app = express();
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter: h.gather,
      authTokenGetter: () => WEBHOOK_TOKEN,
      publicBaseUrl: PUBLIC_BASE_URL,
      resolveTenantId: () => TENANT,
      voiceSessionStore: h.store,
    }),
  );
  return app;
}

describe('realtime hand-off — Twilio refuses the transfer', () => {
  it('falls back to the Gather degrade, and the fallback webhook bridges the call to the dispatcher', async () => {
    const twilioRest = makeTwilioRest((body) =>
      body.has('Twiml') ? { ok: false, status: 400 } : { ok: true, status: 200 },
    );
    const h = await harness({ twilio: twilioRest });

    h.say('I want to speak to a person');
    await vi.waitFor(() => expect(h.ws.markNames().some((n) => n.startsWith('silence-arm-'))).toBe(true));
    h.ws.ackAllMarks(h.streamSid);

    await vi.waitFor(() => expect(h.twilio.degrades()).toHaveLength(1));
    expect(h.twilio.transfers()).toHaveLength(1);
    await vi.waitFor(() => expect(h.ws.closed).toBe(true));
    expect(h.ws.closeReason).toBe('degraded_to_gather');

    // Twilio now re-requests TwiML from the fallback webhook for this call.
    const res = await signedPost(telephonyApp(h), '/api/telephony/voice/gather-fallback', {
      CallSid: h.callSid,
      From: CALLER,
      To: '+15125550999',
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Dial');
    expect(res.text).toContain(DISPATCHER);
    expect(res.text).toContain(`/api/telephony/dial-result?sid=${encodeURIComponent(h.session.id)}`);
    expect(res.text).not.toContain('<Stream');
  });

  it('when the transfer AND the Gather degrade are both refused, the caller is told and the call ends', async () => {
    // e.g. a broken tenant credential: every Calls REST update is refused.
    const twilioRest = makeTwilioRest(() => ({ ok: false, status: 401 }));
    const h = await harness({ twilio: twilioRest });
    const spoken = () =>
      (h.tts.synthesize as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => (input as { text: string }).text);

    h.say('I want to speak to a person');
    await vi.waitFor(() => expect(h.ws.markNames().some((n) => n.startsWith('silence-arm-'))).toBe(true));
    h.ws.ackAllMarks(h.streamSid);

    await vi.waitFor(() => expect(h.twilio.degrades()).toHaveLength(1));
    await vi.waitFor(() => expect(spoken()).toContain(HANDOFF_UNAVAILABLE_COPY));
    await vi.waitFor(() => expect(h.ws.markNames().filter((n) => n.startsWith('silence-arm-'))).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 30));
    expect(h.ws.closed).toBe(false); // the apology is still playing
    h.ws.ackAllMarks(h.streamSid);
    await vi.waitFor(() => expect(h.ws.closed).toBe(true));
    expect(h.finalizeOnClose).toHaveBeenCalledTimes(1);
    const [, , effects] = h.finalizeOnClose.mock.calls[0];
    expect(effects).toEqual([
      expect.objectContaining({
        type: 'end_session',
        payload: expect.objectContaining({ reason: 'system_failure:handoff_undeliverable' }),
      }),
    ]);
  });
});
