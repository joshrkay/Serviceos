/**
 * #1331 — no phone turn waits past the 7 s floor silently.
 *
 * Layer 2 run 36938493716 (reschedule-appointment-known-customer, run 2,
 * turn 1): the agent's buffered `synthesize()` call stalled until its 30 s
 * fetch timeout ("mediastream: TTS turn failed — The operation was aborted
 * due to timeout"), so the caller heard the 250 ms filler and then nothing:
 * the confirmation reply was never spoken. The floor grader measured
 * 13 347 ms (transcript → call end) against the 7 000 ms hard cap.
 *
 * Seam: the public `TwilioMediaStreamAdapter` — inbound Twilio/Deepgram
 * frames in, outbound `media` frames + session voice events out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/analytics/posthog', () => ({
  recordVoiceError: () => undefined,
}));

import {
  TwilioMediaStreamAdapter,
  type WsLike,
} from '../../../src/telephony/media-streams/mediastream-adapter';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import type { VoiceSessionEvent } from '../../../src/ai/agents/customer-calling/voice-session-store';
import type {
  StreamingSession,
  StreamingTranscriptionProvider,
  StreamingTranscriptCallback,
  StreamingTranscriptEvent,
} from '../../../src/voice/transcription-providers';
import type {
  TtsProvider,
  TtsSynthesizeInput,
  TtsSynthesizeResult,
} from '../../../src/ai/tts/tts-provider';
import { VOICE_EVENT_CHANNEL } from '../../../src/ai/voice-quality/event-bus';
import { TURN_HOLD_COPY } from '../../../src/ai/agents/customer-calling/tts-copy';

class FakeWs implements WsLike {
  sent: Array<Record<string, unknown>> = [];
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
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
  media(): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.event === 'media');
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
      openSession: vi.fn((onEvent) => {
        cb = onEvent;
        return Promise.resolve(session);
      }),
    },
    emit: (evt) => cb?.(evt),
  };
}

const PCM_OK: TtsSynthesizeResult = {
  audio: Buffer.alloc(640 * 3),
  contentType: 'audio/pcm',
  provider: 'test',
};

/** A synth that never answers on its own — only an abort releases it. */
function stalledSynth(input: TtsSynthesizeInput): Promise<TtsSynthesizeResult> {
  return new Promise((_resolve, reject) => {
    input.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let store: VoiceSessionStore;
beforeEach(() => {
  store = new VoiceSessionStore({ startInterval: false });
});

function startCall(opts: {
  callSid: string;
  ttsProvider: TtsProvider;
  speechTurn: () => Promise<Array<{ type: string; payload?: Record<string, unknown> }>>;
  extraDeps?: Record<string, unknown>;
}) {
  store.create('t', 'telephony', { callSid: opts.callSid });
  const ws = new FakeWs();
  const stt = makeStreamingProvider();
  const adapter = new TwilioMediaStreamAdapter(
    {
      store,
      streamingProvider: stt.provider,
      speechTurn: opts.speechTurn as never,
      ttsProvider: opts.ttsProvider,
      ...(opts.extraDeps ?? {}),
    },
    ws,
  );
  adapter.start();
  const session = store.findByCallSid(opts.callSid)!;
  const events: VoiceSessionEvent[] = [];
  session.events.on(VOICE_EVENT_CHANNEL, (e: VoiceSessionEvent) => events.push(e));
  ws.inboundJson({
    event: 'start',
    streamSid: `MZ-${opts.callSid}`,
    start: {
      callSid: opts.callSid,
      accountSid: 'AC',
      streamSid: `MZ-${opts.callSid}`,
      tracks: ['inbound'],
    },
  });
  return { ws, stt, events };
}

describe('#1331 — buffered TTS synth is bounded per attempt', () => {
  it('abandons a stalled synthesize() attempt and retries once, so the reply still plays', async () => {
    let calls = 0;
    const tts: TtsProvider = {
      synthesize: vi.fn(async (input: TtsSynthesizeInput) => {
        calls += 1;
        return calls === 1 ? stalledSynth(input) : PCM_OK;
      }),
    };
    const { ws, stt, events } = startCall({
      callSid: 'CA-tts-stall',
      ttsProvider: tts,
      speechTurn: async () => [
        { type: 'tts_play', payload: { text: "I've passed that along to our team." } },
      ],
      extraDeps: { ttsAttemptTimeoutMs: 60 },
    });
    await sleep(5);
    stt.emit({ type: 'final', isFinal: true, transcript: 'Yes', confidence: 0.99 });

    await sleep(200);

    expect(tts.synthesize).toHaveBeenCalledTimes(2);
    expect(ws.media().length).toBeGreaterThan(0);
    const heard = events.find((e) => e.type === 'audio_frame_emitted');
    const said = events.find((e) => e.type === 'transcript_received');
    expect(heard).toBeDefined();
    expect(heard!.ts - said!.ts).toBeLessThan(200);
  });
});

describe('#1331 — a slow turn speaks an honest holding line before the floor', () => {
  const okTts = (): TtsProvider => ({ synthesize: vi.fn(async () => PCM_OK) });

  it('when the turn is still thinking at the hold deadline, the caller hears the holding line, then the reply', async () => {
    const tts = okTts();
    let releaseTurn: () => void = () => undefined;
    const { ws, stt, events } = startCall({
      callSid: 'CA-slow-turn',
      ttsProvider: tts,
      speechTurn: async () => {
        await new Promise<void>((r) => {
          releaseTurn = r;
        });
        return [{ type: 'tts_play', payload: { text: 'Your appointment is moved to Wednesday.' } }];
      },
      extraDeps: { turnHoldDeadlineMs: 50 },
    });
    await sleep(5);
    stt.emit({ type: 'final', isFinal: true, transcript: 'Yes', confidence: 0.99 });

    await sleep(150);
    // The turn is still thinking — the caller already heard the honest hold.
    const spokenSoFar = (tts.synthesize as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as TtsSynthesizeInput).text,
    );
    expect(spokenSoFar).toEqual(["Sorry for the wait — I'm still working on that."]);
    expect(TURN_HOLD_COPY).toBe("Sorry for the wait — I'm still working on that.");
    expect(ws.media().length).toBeGreaterThan(0);
    const said = events.find((e) => e.type === 'transcript_received')!;
    const heard = events.find((e) => e.type === 'audio_frame_emitted')!;
    expect(heard.ts - said.ts).toBeLessThan(150);
    // Observable on the session bus, so reports can count slow turns.
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'repair_template_fired', trigger: 'turn_hold' }),
    );

    // The real reply still plays once the turn finishes.
    releaseTurn();
    await sleep(100);
    const spoken = (tts.synthesize as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as TtsSynthesizeInput).text,
    );
    expect(spoken).toEqual([
      "Sorry for the wait — I'm still working on that.",
      'Your appointment is moved to Wednesday.',
    ]);
  });

  it('after a hold, the real reply is marked on the bus too, so a listener knows the answer arrived', async () => {
    let releaseTurn: () => void = () => undefined;
    const { stt, events } = startCall({
      callSid: 'CA-slow-turn-mark',
      ttsProvider: okTts(),
      speechTurn: async () => {
        await new Promise<void>((r) => {
          releaseTurn = r;
        });
        return [{ type: 'tts_play', payload: { text: 'Your appointment is moved to Wednesday.' } }];
      },
      extraDeps: { turnHoldDeadlineMs: 50 },
    });
    await sleep(5);
    stt.emit({ type: 'final', isFinal: true, transcript: 'Yes', confidence: 0.99 });
    await sleep(150);
    expect(events.filter((e) => e.type === 'audio_frame_emitted')).toHaveLength(1);
    releaseTurn();
    await sleep(100);
    expect(events.filter((e) => e.type === 'audio_frame_emitted')).toHaveLength(2);
  });

  it('a turn that answers before the hold deadline never speaks the holding line', async () => {
    const tts = okTts();
    const { stt } = startCall({
      callSid: 'CA-fast-turn',
      ttsProvider: tts,
      speechTurn: async () => [{ type: 'tts_play', payload: { text: 'You have two recent jobs.' } }],
      extraDeps: { turnHoldDeadlineMs: 80 },
    });
    await sleep(5);
    stt.emit({ type: 'final', isFinal: true, transcript: 'What jobs do I have?', confidence: 0.99 });
    await sleep(200);
    const spoken = (tts.synthesize as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as TtsSynthesizeInput).text,
    );
    expect(spoken).toEqual(['You have two recent jobs.']);
  });
});
