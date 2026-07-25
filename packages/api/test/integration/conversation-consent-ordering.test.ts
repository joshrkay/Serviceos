/**
 * Recording-consent ordering — the recording disclosure always completes
 * before any caller audio is captured, on BOTH telephony transports, and a
 * disclosure-init failure hangs up instead of continuing to record.
 *
 * Three independently-asserted paths:
 *   1. Gather/PSTN — buildTwiML emits the disclosure `<Say>` BEFORE the async
 *      `<Start><Record>` block, so Twilio speaks the notice before it arms
 *      recording (twilio-adapter.ts).
 *   2. Media Streams — the WS adapter does NOT forward inbound `media` frames
 *      to Deepgram until `initializeSession` (which runs disclosure) resolves;
 *      frames that arrive while the disclosure is still playing are dropped
 *      (mediastream-adapter.ts).
 *   3. DISCLOSURE_INIT_FAILED — when `initializeSession` throws, the leg is
 *      HUNG UP (WS closed) rather than left recording an undisclosed caller.
 *
 * The suite prints a single machine-greppable gate line summarising the two
 * failure counters across all three paths:
 *   CONSENT-ORDER: <n> armed-before-disclosure, <n> fail-open
 *
 * Both counters must be 0. This lives under test/integration/ (following the
 * conversation-*.test.ts convention) so it runs in the same PR CI lane; it is
 * a pure adapter-behavior check and does not touch Postgres.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { buildTwiML, TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import {
  buildDegradeFallbackTwiml,
  createTelephonyRouter,
  voicemailTwimlForGateReason,
} from '../../src/routes/telephony';
import {
  TwilioMediaStreamAdapter,
  type WsLike,
} from '../../src/telephony/media-streams/mediastream-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type {
  StreamingSession,
  StreamingTranscriptionProvider,
  StreamingTranscriptCallback,
} from '../../src/voice/transcription-providers';
import type { SideEffect } from '../../src/ai/agents/customer-calling/types';

// ─── Aggregate violation counters (0 == compliant) ──────────────────────────

/** Times caller audio was captured/armed before the disclosure completed. */
let armedBeforeDisclosure = 0;
/** Times a disclosure-init failure continued to record instead of hanging up. */
let failOpen = 0;

afterAll(() => {
  // Single greppable gate line — printed passing or not so the harness can
  // read the outcome directly from the transcript. Written straight to
  // process.stdout (not console.log) so vitest's console interception doesn't
  // swallow output emitted from a hook after the tasks have finished.
  process.stdout.write(
    `CONSENT-ORDER: ${armedBeforeDisclosure} armed-before-disclosure, ${failOpen} fail-open\n`,
  );
});

// ─── Fakes (hand-rolled, no DB) ─────────────────────────────────────────────

class FakeWs implements WsLike {
  closed = false;
  closeCode: number | undefined;
  closeReason: string | undefined;
  /** Captured outbound frames — used to find the disclosure turn's completion mark. */
  sent: Array<Record<string, unknown>> = [];
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

  on(event: string, listener: (...args: unknown[]) => void): void {
    (this.listeners[event] ??= []).push(listener);
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const l of this.listeners[event] ?? []) l(...args);
  }

  inboundJson(obj: unknown): void {
    this.fire('message', JSON.stringify(obj));
  }
}

function makeStreamingProvider(): {
  provider: StreamingTranscriptionProvider;
  session: StreamingSession & { send: ReturnType<typeof vi.fn> };
} {
  const session = {
    send: vi.fn(),
    finish: vi.fn(),
    destroy: vi.fn(),
  };
  const provider: StreamingTranscriptionProvider = {
    openSession: vi.fn((_onEvent: StreamingTranscriptCallback) =>
      Promise.resolve(session as unknown as StreamingSession),
    ),
  };
  return { provider, session };
}

/** Buffered PCM TTS so the greeting/disclosure turn enqueues audio + a completion mark. */
function makeTtsProvider() {
  return {
    synthesize: vi.fn(async () => ({
      audio: Buffer.alloc(640),
      contentType: 'audio/pcm',
      provider: 'test',
    })),
  };
}

const flush = () => new Promise((r) => setImmediate(r));

/** Find the disclosure/greeting turn's end-of-utterance completion mark name. */
function silenceArmMarkName(ws: FakeWs): string | undefined {
  const frame = ws.sent.find(
    (f) =>
      f.event === 'mark' &&
      typeof (f.mark as { name?: string } | undefined)?.name === 'string' &&
      (f.mark as { name: string }).name.startsWith('silence-arm-'),
  );
  return (frame?.mark as { name: string } | undefined)?.name;
}

/**
 * Drive the REAL POST /voice route with a blocking gate and return its TwiML.
 * The builder taking a callback argument proves nothing on its own — the
 * defect this pins was in the WIRING: the route passed a URL for a handler
 * that never persists anything.
 */
async function gateBlockedVoiceTwiml(): Promise<string> {
  const AUTH_TOKEN = 'test-tw-token-consent-gate';
  const PUBLIC_BASE_URL = 'https://api.test';
  const store = new VoiceSessionStore({ startInterval: false });
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: { complete: vi.fn() } as never,
    businessName: 'Test Co',
    publicBaseUrl: PUBLIC_BASE_URL,
  });
  const app = express();
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter,
      authTokenGetter: () => AUTH_TOKEN,
      publicBaseUrl: PUBLIC_BASE_URL,
      resolveTenantId: () => 'tenant-consent-gate',
      voiceGate: async () => ({ allowed: false, reason: 'not_live' as const }),
    }),
  );

  const params = { CallSid: 'CA-consent-gate', From: '+15125550100', To: '+15125550999' };
  const path = '/api/telephony/voice';
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${PUBLIC_BASE_URL}${path}`, params);
  const res = await request(app)
    .post(path)
    .set('X-Twilio-Signature', sig)
    .type('form')
    .send(params);
  return res.text;
}

const startFrame = (callSid: string, streamSid: string) => ({
  event: 'start' as const,
  streamSid,
  start: { callSid, accountSid: 'AC', streamSid, tracks: ['inbound'] },
});

const mediaFrame = { event: 'media' as const, media: { payload: 'AAAA' } };

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('recording-consent ordering — disclosure precedes audio capture', () => {
  it('Path 1 (Gather/PSTN): buildTwiML emits the disclosure <Say> before <Start><Record>', () => {
    const disclosure: SideEffect = {
      type: 'tts_play',
      payload: { text: 'Thanks for calling Acme. This call may be recorded.' },
    };
    const xml = buildTwiML([disclosure], {
      gatherActionUrl: 'https://api.test/api/telephony/gather?sid=s1',
      recordingStatusCallback: 'https://api.test/api/telephony/recording',
    });

    const sayIdx = xml.indexOf('<Say');
    const recordIdx = xml.indexOf('<Start><Record');

    // Both verbs must be present, and the notice must be spoken first.
    expect(sayIdx).toBeGreaterThanOrEqual(0);
    expect(recordIdx).toBeGreaterThanOrEqual(0);
    if (!(sayIdx >= 0 && recordIdx >= 0 && sayIdx < recordIdx)) {
      armedBeforeDisclosure += 1;
    }
    expect(sayIdx).toBeLessThan(recordIdx);
  });

  it('Path 2 (Media Streams): inbound audio is NOT consumed until the disclosure has PLAYED', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    store.create('tenant-consent', 'telephony', { callSid: 'CA-consent' });

    // A deferred `initializeSession` lets us inject a media frame WHILE the
    // disclosure is still in flight (the first race the consent gate closes).
    let resolveDisclosure!: (fx: SideEffect[]) => void;
    const disclosureGate = new Promise<SideEffect[]>((resolve) => {
      resolveDisclosure = resolve;
    });

    const { provider, session } = makeStreamingProvider();
    const ws = new FakeWs();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        ttsProvider: makeTtsProvider(),
        speechTurn: async () => [],
        initializeSession: () => disclosureGate,
      },
      ws,
    );
    adapter.start();

    // Deepgram opens synchronously; disclosure stays pending.
    ws.inboundJson(startFrame('CA-consent', 'MZ-consent'));
    await flush();

    // (a) Caller audio arriving while the disclosure step is still running must
    // be dropped, not sent to STT.
    ws.inboundJson(mediaFrame);
    await flush();
    if (session.send.mock.calls.length > 0) armedBeforeDisclosure += 1;
    expect(session.send).not.toHaveBeenCalled();

    // The disclosure step resolves and its greeting audio is synthesized and
    // enqueued — but Twilio has NOT yet acknowledged playback completion.
    resolveDisclosure([{ type: 'tts_play', payload: { text: 'This call may be recorded.' } }]);
    await flush();
    await flush();

    // (b) Caller audio arriving after the audio is ENQUEUED but before Twilio
    // ACKs the end-of-utterance mark must STILL be dropped — the caller has not
    // finished hearing the disclosure.
    ws.inboundJson(mediaFrame);
    await flush();
    if (session.send.mock.calls.length > 0) armedBeforeDisclosure += 1;
    expect(session.send).not.toHaveBeenCalled();

    // Twilio ACKs the disclosure turn's end-of-utterance mark → playback
    // complete → capture arms → subsequent audio flows to STT.
    const markName = silenceArmMarkName(ws);
    expect(markName).toBeDefined();
    ws.inboundJson({ event: 'mark', streamSid: 'MZ-consent', mark: { name: markName } });
    await flush();
    ws.inboundJson(mediaFrame);
    await flush();
    expect(session.send).toHaveBeenCalledTimes(1);
  });

  it('Path 3 (DISCLOSURE_INIT_FAILED): the leg hangs up instead of continuing to record', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    store.create('tenant-fail', 'telephony', { callSid: 'CA-fail' });

    const { provider, session } = makeStreamingProvider();
    const ws = new FakeWs();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
        initializeSession: async () => {
          throw new Error('disclosure ledger write failed');
        },
      },
      ws,
    );
    adapter.start();

    ws.inboundJson(startFrame('CA-fail', 'MZ-fail'));
    await flush();

    // A disclosure failure must HANG UP (WS closed); continuing would record
    // an undisclosed caller.
    if (!ws.closed) failOpen += 1;
    expect(ws.closed).toBe(true);
    expect(ws.closeReason).toBe('disclosure_init_failed');

    // And no caller audio is ever forwarded on the failed leg.
    ws.inboundJson(mediaFrame);
    await flush();
    if (session.send.mock.calls.length > 0) failOpen += 1;
    expect(session.send).not.toHaveBeenCalled();
  });

  it('Path 3b (disclosure TTS produces no playback): fails closed — hangs up, does not arm', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    store.create('tenant-noplay', 'telephony', { callSid: 'CA-noplay' });

    const { provider, session } = makeStreamingProvider();
    const ws = new FakeWs();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        // TTS that returns a compressed (non-PCM) format the media pipeline
        // refuses to stream — so the greeting/disclosure turn produces NO audio
        // frames and NO end-of-utterance completion mark. The caller heard no
        // disclosure; capture must NOT open on the missing ACK.
        ttsProvider: {
          synthesize: vi.fn(async () => ({
            audio: Buffer.from('ID3-fake-mp3'),
            contentType: 'audio/mpeg',
            provider: 'test',
          })),
        },
        speechTurn: async () => [],
        initializeSession: async () => [
          { type: 'tts_play', payload: { text: 'This call may be recorded.' } },
        ],
      },
      ws,
    );
    adapter.start();

    ws.inboundJson(startFrame('CA-noplay', 'MZ-noplay'));
    await flush();
    await flush();

    // A disclosure turn that produced no playback is a compliance failure —
    // fail closed (hang up), never arm capture on an undisclosed caller.
    if (!ws.closed) failOpen += 1;
    expect(ws.closed).toBe(true);
    expect(ws.closeReason).toBe('disclosure_init_failed');

    ws.inboundJson(mediaFrame);
    await flush();
    if (session.send.mock.calls.length > 0) failOpen += 1;
    expect(session.send).not.toHaveBeenCalled();
  });

  it('Path 3c (filler-only recovery): a filler clip is not the disclosure — fails closed', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    store.create('tenant-filler', 'telephony', { callSid: 'CA-filler' });

    const { provider, session } = makeStreamingProvider();
    const ws = new FakeWs();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        // Streaming TTS fails, and the buffered fallback returns non-PCM — so
        // recoverTurnAfterStreamFailure falls through to a generic FILLER clip
        // and arms an end-of-utterance mark. That mark must NOT be accepted as
        // disclosure playback: the caller heard an apology filler, not the
        // recording notice.
        ttsProvider: {
          synthesize: vi.fn(async () => ({
            audio: Buffer.from('ID3-fake-mp3'),
            contentType: 'audio/mpeg',
            provider: 'test',
          })),
          // eslint-disable-next-line require-yield
          synthesizeStream: vi.fn(async function* () {
            throw new Error('TTS stream died mid-turn');
          }),
        },
        fillerEngine: { selectNext: () => ({ id: 'f1', text: 'One moment…', approxDurationMs: 500 }) },
        fillerCache: { get: () => Buffer.alloc(640) },
        speechTurn: async () => [],
        initializeSession: async () => [
          { type: 'tts_play', payload: { text: 'This call may be recorded.' } },
        ],
      },
      ws,
    );
    adapter.start();

    ws.inboundJson(startFrame('CA-filler', 'MZ-filler'));
    await flush();
    await flush();
    await flush();

    // Filler-only playback is NOT consent — fail closed.
    if (!ws.closed) failOpen += 1;
    expect(ws.closed).toBe(true);
    expect(ws.closeReason).toBe('disclosure_init_failed');

    // Even if Twilio ACKs the filler turn's completion mark, capture must stay
    // shut — the mark belongs to a filler, not the disclosure.
    const markName = silenceArmMarkName(ws);
    if (markName) {
      ws.inboundJson({ event: 'mark', streamSid: 'MZ-filler', mark: { name: markName } });
      await flush();
    }
    ws.inboundJson(mediaFrame);
    await flush();
    if (session.send.mock.calls.length > 0) failOpen += 1;
    expect(session.send).not.toHaveBeenCalled();
  });

  it('Path 3d (TRUNCATED disclosure): a partial notice is not consent — fails closed', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    store.create('tenant-trunc', 'telephony', { callSid: 'CA-trunc' });

    const { provider, session } = makeStreamingProvider();
    const ws = new FakeWs();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        ttsProvider: {
          // Buffered recovery also unusable (non-PCM), so the turn ends on a
          // filler after a PARTIAL real chunk.
          synthesize: vi.fn(async () => ({
            audio: Buffer.from('ID3-fake-mp3'),
            contentType: 'audio/mpeg',
            provider: 'test',
          })),
          // Emits ONE real chunk (so real audio genuinely reached the caller)
          // and then dies — the caller heard only the opening fragment of the
          // recording notice. Per-frame tracking would call this "played".
          synthesizeStream: vi.fn(async function* () {
            yield { pcm: Buffer.alloc(640), isFinal: false };
            throw new Error('TTS stream died after first chunk');
          }),
        },
        fillerEngine: { selectNext: () => ({ id: 'f1', text: 'One moment…', approxDurationMs: 500 }) },
        fillerCache: { get: () => Buffer.alloc(640) },
        speechTurn: async () => [],
        initializeSession: async () => [
          { type: 'tts_play', payload: { text: 'This call may be recorded for quality and training.' } },
        ],
      },
      ws,
    );
    adapter.start();

    ws.inboundJson(startFrame('CA-trunc', 'MZ-trunc'));
    await flush();
    await flush();
    await flush();

    // Real audio DID stream, but the turn never completed — a truncated
    // disclosure is not consent.
    if (!ws.closed) failOpen += 1;
    expect(ws.closed).toBe(true);
    expect(ws.closeReason).toBe('disclosure_init_failed');

    const markName = silenceArmMarkName(ws);
    if (markName) {
      ws.inboundJson({ event: 'mark', streamSid: 'MZ-trunc', mark: { name: markName } });
      await flush();
    }
    ws.inboundJson(mediaFrame);
    await flush();
    if (session.send.mock.calls.length > 0) failOpen += 1;
    expect(session.send).not.toHaveBeenCalled();
  });

  it('Path 3f (premature stream close, no isFinal): incomplete notice — fails closed', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    store.create('tenant-nofinal', 'telephony', { callSid: 'CA-nofinal' });

    const { provider, session } = makeStreamingProvider();
    const ws = new FakeWs();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        ttsProvider: {
          synthesize: vi.fn(async () => ({
            audio: Buffer.from('ID3-fake-mp3'),
            contentType: 'audio/mpeg',
            provider: 'test',
          })),
          // Yields audio then ENDS CLEANLY without ever emitting isFinal —
          // exactly what the ElevenLabs iterator does when its WebSocket closes
          // early (its `close` listener calls finish() unconditionally). The
          // loop exits normally, so this is not an error path; the turn is
          // nonetheless truncated and must not count as a played disclosure.
          synthesizeStream: vi.fn(async function* () {
            yield { pcm: Buffer.alloc(640), isFinal: false };
          }),
        },
        speechTurn: async () => [],
        initializeSession: async () => [
          { type: 'tts_play', payload: { text: 'This call may be recorded for quality and training.' } },
        ],
      },
      ws,
    );
    adapter.start();

    ws.inboundJson(startFrame('CA-nofinal', 'MZ-nofinal'));
    await flush();
    await flush();
    await flush();

    if (!ws.closed) failOpen += 1;
    expect(ws.closed).toBe(true);
    expect(ws.closeReason).toBe('disclosure_init_failed');

    const markName = silenceArmMarkName(ws);
    if (markName) {
      ws.inboundJson({ event: 'mark', streamSid: 'MZ-nofinal', mark: { name: markName } });
      await flush();
    }
    ws.inboundJson(mediaFrame);
    await flush();
    if (session.send.mock.calls.length > 0) failOpen += 1;
    expect(session.send).not.toHaveBeenCalled();
  });

  it('Path 3i (lost mark ACK, long greeting): the backstop waits out real playback, not a constant', async () => {
    vi.useFakeTimers();
    try {
      const store = new VoiceSessionStore({ startInterval: false });
      store.create('tenant-long', 'telephony', { callSid: 'CA-long' });

      // ~40 s of PCM16 @ 16 kHz mono (32 bytes per ms) — a 500-char custom
      // greeting with the disclosure appended after it, which out-runs the
      // fixed 30 s backstop. Twilio never ACKs the COMPLETION mark.
      const LONG_PCM_MS = 40_000;
      const SIXTY_SECONDS_OF_PCM = LONG_PCM_MS * 32;
      const { provider, session } = makeStreamingProvider();
      const ws = new FakeWs();
      const adapter = new TwilioMediaStreamAdapter(
        {
          store,
          streamingProvider: provider,
          ttsProvider: {
            synthesize: vi.fn(async () => ({
              audio: Buffer.alloc(SIXTY_SECONDS_OF_PCM),
              contentType: 'audio/pcm',
              provider: 'test',
            })),
          },
          speechTurn: async () => [],
          initializeSession: async () => [
            { type: 'tts_play', payload: { text: 'Long custom greeting… This call may be recorded.' } },
          ],
        },
        ws,
      );
      adapter.start();

      ws.inboundJson(startFrame('CA-long', 'MZ-long'));

      // Let the turn's audio drain, ACKing the per-chunk `turn-*` backpressure
      // marks as Twilio would. The end-of-utterance `silence-arm-*` mark is
      // deliberately NEVER acked — that is the lost ACK under test.
      const acked = new Set<string>();
      for (let i = 0; i < 40 && !silenceArmMarkName(ws); i += 1) {
        for (const f of ws.sent) {
          const name = (f.mark as { name?: string } | undefined)?.name;
          if (f.event === 'mark' && name && !name.startsWith('silence-arm-') && !acked.has(name)) {
            acked.add(name);
            ws.inboundJson({ event: 'mark', streamSid: 'MZ-long', mark: { name } });
          }
        }
        await vi.advanceTimersByTimeAsync(50);
      }
      // The whole turn is enqueued and its completion mark emitted (unacked).
      expect(silenceArmMarkName(ws)).toBeDefined();

      // The old fixed 30 s constant would open capture here — while ~40 s of
      // greeting (and the disclosure appended after it) is still playing.
      await vi.advanceTimersByTimeAsync(30_000);
      ws.inboundJson(mediaFrame);
      await vi.advanceTimersByTimeAsync(10);
      if (session.send.mock.calls.length > 0) armedBeforeDisclosure += 1;
      expect(session.send).not.toHaveBeenCalled();

      // Past the real playback duration + margin, the lost-ACK backstop may
      // finally open capture so a dropped mark can't leave the agent deaf.
      await vi.advanceTimersByTimeAsync(LONG_PCM_MS);
      ws.inboundJson(mediaFrame);
      await vi.advanceTimersByTimeAsync(10);
      expect(session.send).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Path 3h (buffered PCM but zero-length audio): silence is not a disclosure — fails closed', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    store.create('tenant-empty', 'telephony', { callSid: 'CA-empty' });

    const { provider, session } = makeStreamingProvider();
    const ws = new FakeWs();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        // Well-formed PCM content type but an EMPTY buffer: streamPcmAsMedia
        // loops zero times and emits no media, yet the turn still reaches its
        // end-of-utterance mark. The caller heard nothing.
        ttsProvider: {
          synthesize: vi.fn(async () => ({
            audio: Buffer.alloc(0),
            contentType: 'audio/pcm',
            provider: 'test',
          })),
        },
        speechTurn: async () => [],
        initializeSession: async () => [
          { type: 'tts_play', payload: { text: 'This call may be recorded.' } },
        ],
      },
      ws,
    );
    adapter.start();

    ws.inboundJson(startFrame('CA-empty', 'MZ-empty'));
    await flush();
    await flush();
    await flush();

    if (!ws.closed) failOpen += 1;
    expect(ws.closed).toBe(true);
    expect(ws.closeReason).toBe('disclosure_init_failed');

    const markName = silenceArmMarkName(ws);
    if (markName) {
      ws.inboundJson({ event: 'mark', streamSid: 'MZ-empty', mark: { name: markName } });
      await flush();
    }
    ws.inboundJson(mediaFrame);
    await flush();
    if (session.send.mock.calls.length > 0) failOpen += 1;
    expect(session.send).not.toHaveBeenCalled();
  });

  it('Path 3g (foreign mark ACK mid-disclosure): only the validated disclosure turn opens capture', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    store.create('tenant-race', 'telephony', { callSid: 'CA-race' });

    // WS frames are handled concurrently with handleStart's validation, so a
    // `silence-arm-*` ACK can land while the disclosure is still in flight —
    // a filler's mark, a later prompt's, or a stale one. Only the validated
    // disclosure turn's own mark may open capture; anything else must be
    // ignored. Held open on a deferred initializeSession so the leg is still
    // ALIVE during the window (once a leg closes, handleClose nulls the
    // Deepgram session and media is dropped for an unrelated reason, which
    // would mask the bug rather than expose it).
    let resolveDisclosure!: (fx: SideEffect[]) => void;
    const disclosureGate = new Promise<SideEffect[]>((resolve) => {
      resolveDisclosure = resolve;
    });

    const { provider, session } = makeStreamingProvider();
    const ws = new FakeWs();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        ttsProvider: makeTtsProvider(),
        speechTurn: async () => [],
        initializeSession: () => disclosureGate,
      },
      ws,
    );
    adapter.start();

    ws.inboundJson(startFrame('CA-race', 'MZ-race'));
    await flush();

    // Foreign completion marks ACK while the disclosure is still pending. The
    // leg is open and Deepgram is live, so the ONLY thing standing between
    // these frames and the ASR is the consent latch.
    for (const name of ['silence-arm-0', 'silence-arm-1', 'silence-arm-99']) {
      ws.inboundJson({ event: 'mark', streamSid: 'MZ-race', mark: { name } });
      ws.inboundJson(mediaFrame);
      await flush();
    }
    if (session.send.mock.calls.length > 0) armedBeforeDisclosure += 1;
    expect(session.send).not.toHaveBeenCalled();

    // The real disclosure now completes; its own mark is what opens capture.
    resolveDisclosure([{ type: 'tts_play', payload: { text: 'This call may be recorded.' } }]);
    await flush();
    await flush();

    // Still shut until that specific mark is ACKed.
    ws.inboundJson(mediaFrame);
    await flush();
    if (session.send.mock.calls.length > 0) armedBeforeDisclosure += 1;
    expect(session.send).not.toHaveBeenCalled();

    const markName = silenceArmMarkName(ws);
    expect(markName).toBeDefined();
    ws.inboundJson({ event: 'mark', streamSid: 'MZ-race', mark: { name: markName } });
    await flush();
    ws.inboundJson(mediaFrame);
    await flush();
    expect(session.send).toHaveBeenCalledTimes(1);
  });

  it('Path 3e (later prompt cannot mask a failed greeting): fails closed on the FIRST turn', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    store.create('tenant-mask', 'telephony', { callSid: 'CA-mask' });

    const { provider, session } = makeStreamingProvider();
    const ws = new FakeWs();
    // The greeting (which carries the disclosure) fails to produce audio; a
    // LATER prompt in the same init effects streams fine. The verdict must be
    // bound to the greeting turn, so the healthy second turn cannot mask it.
    let call = 0;
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        ttsProvider: {
          synthesize: vi.fn(async () => {
            call += 1;
            return call === 1
              ? { audio: Buffer.from('ID3-fake-mp3'), contentType: 'audio/mpeg', provider: 'test' }
              : { audio: Buffer.alloc(640), contentType: 'audio/pcm', provider: 'test' };
          }),
        },
        speechTurn: async () => [],
        initializeSession: async () => [
          { type: 'tts_play', payload: { text: 'This call may be recorded.' } },
          { type: 'tts_play', payload: { text: 'Can I get your name?' } },
        ],
      },
      ws,
    );
    adapter.start();

    ws.inboundJson(startFrame('CA-mask', 'MZ-mask'));
    await flush();
    await flush();
    await flush();

    if (!ws.closed) failOpen += 1;
    expect(ws.closed).toBe(true);
    expect(ws.closeReason).toBe('disclosure_init_failed');

    ws.inboundJson(mediaFrame);
    await flush();
    if (session.send.mock.calls.length > 0) failOpen += 1;
    expect(session.send).not.toHaveBeenCalled();
  });

  // ─── Paths 4-6: capture entry points OUTSIDE the greeting turn ────────────
  // The three above all run through establishment. These do not, which is
  // exactly why they regressed silently: nothing in this suite could observe
  // them, and one of them (Path 4) was actively asserted as correct by a
  // resilience test that never ran a disclosure.

  it('Path 4 (realtime→Gather degrade): fallback TwiML carries the disclosure when the session was never disclosed', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    // A session that exists but has heard nothing — the shape produced when
    // the STT socket fails to open, since `<Connect><Stream>` speaks nothing
    // and establishment never ran.
    const session = store.create('tenant-degrade', 'telephony', { callSid: 'CA-degrade' });
    expect(session.recordingDisclosed).toBeFalsy();

    const twiml = buildDegradeFallbackTwiml(session, 'https://x.test/api/telephony/gather', 'en');

    // The Gather arms speech recognition, so the notice must precede it.
    const disclosureAt = twiml.indexOf('may be recorded');
    const gatherAt = twiml.indexOf('<Gather');
    if (disclosureAt === -1 || disclosureAt > gatherAt) armedBeforeDisclosure += 1;
    expect(disclosureAt).toBeGreaterThan(-1);
    expect(disclosureAt).toBeLessThan(gatherAt);
    // And it latches, so the caller isn't re-disclosed on every later turn.
    expect(session.recordingDisclosed).toBe(true);

    const second = buildDegradeFallbackTwiml(session, 'https://x.test/api/telephony/gather', 'en');
    expect(second).not.toContain('may be recorded');
  });

  it('Path 5 (recording objection): revoking capture stops STT frames, not just the Twilio recording', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const voiceSession = store.create('tenant-objection', 'telephony', {
      callSid: 'CA-objection',
    });

    const { provider, session } = makeStreamingProvider();
    const ws = new FakeWs();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        ttsProvider: makeTtsProvider(),
        speechTurn: async () => [],
        initializeSession: async () => [
          { type: 'tts_play', payload: { text: 'This call may be recorded.' } },
        ],
      },
      ws,
    );
    adapter.start();

    ws.inboundJson(startFrame('CA-objection', 'MZ-objection'));
    await flush();
    await flush();
    const mark = silenceArmMarkName(ws);
    if (mark) {
      ws.inboundJson({ event: 'mark', streamSid: 'MZ-objection', mark: { name: mark } });
      await flush();
    }

    // Capture is legitimately armed post-disclosure.
    ws.inboundJson(mediaFrame);
    await flush();
    const framesBefore = session.send.mock.calls.length;
    expect(framesBefore).toBeGreaterThan(0);

    // Caller says "stop recording". On this transport the capture IS the STT
    // socket — pausing a Twilio recording touches nothing — so the revocation
    // has to cut the frame feed or the spoken acknowledgment is a lie.
    voiceSession.captureRevoked = true;
    ws.inboundJson(mediaFrame);
    ws.inboundJson(mediaFrame);
    await flush();
    if (session.send.mock.calls.length > framesBefore) failOpen += 1;
    expect(session.send.mock.calls.length).toBe(framesBefore);
  });

  it('Path 6 (gate-blocked voicemail): the notice precedes <Record> and the audio is ingestible', () => {
    const twiml = voicemailTwimlForGateReason(
      'not_live',
      'https://x.test/api/telephony/recording',
    );
    const sayAt = twiml.indexOf('after the tone');
    const recordAt = twiml.indexOf('<Record');
    if (sayAt === -1 || sayAt > recordAt) armedBeforeDisclosure += 1;
    expect(sayAt).toBeLessThan(recordAt);
    // Without a callback nothing reaches recording-webhook, so no files row
    // exists — and an object with no row survives tenant deprovisioning,
    // which harvests keys from `files`.
    expect(twiml).toContain('recordingStatusCallback=');
  });

  it('Path 6b: the gate-blocked callback targets the ingestion route, not voicemail-status', async () => {
    // /voicemail-status only mints a lead and resolves its tenant from
    // store.findByCallSid — which finds nothing here, because the gate
    // answers before any voice session exists. Pointing there logs "missing
    // tenant" and drops the recording, leaving it unpersisted and beyond
    // deprovision's reach. Only /recording inserts files/voice_recordings.
    const twiml = await gateBlockedVoiceTwiml();
    const callback = /recordingStatusCallback="([^"]+)"/.exec(twiml)?.[1];
    expect(callback).toBeDefined();
    expect(callback).toMatch(/\/api\/telephony\/recording$/);
    expect(callback).not.toMatch(/voicemail-status/);
  });
});
