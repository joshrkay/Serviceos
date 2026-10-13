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
import { HANDOFF_UNAVAILABLE_COPY } from '../../../src/ai/agents/customer-calling/tts-copy';

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
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
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

function makeTtsProvider(): TtsProvider {
  return {
    synthesize: vi.fn(async () => ({
      audio: Buffer.alloc(640),
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
  const tts = makeTtsProvider();
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
      interimEmergencyScan: ({ session: s, speechResult, tenantId }) =>
        gather.scanInterimForEmergency({ sessionId: s.id, speechResult, tenantId }),
      finalizeOnClose,
      publicBaseUrl: PUBLIC_BASE_URL,
      setPendingTransferTwiml: gather.setPendingTransferTwiml.bind(gather),
      takePendingTransferTwiml: gather.takePendingTransferTwiml.bind(gather),
      restRedirect,
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
