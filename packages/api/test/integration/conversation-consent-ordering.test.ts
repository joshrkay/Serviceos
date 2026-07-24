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
import { buildTwiML } from '../../src/telephony/twilio-adapter';
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
});
