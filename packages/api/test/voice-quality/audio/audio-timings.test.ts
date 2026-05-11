/**
 * VQ2-004 — Audio timing helpers + adapter emit-site tests.
 *
 * Pure-function helpers (`ttfaPerTurn`, `lookupToSpeakLatency`,
 * `totalCallDurationMs`) compute per-call latency stats from the unified
 * VoiceSessionEvent timeline. The adapter-level tests drive the Twilio
 * media-stream adapter and assert that `transcript_received` and
 * `audio_frame_emitted` land on the session bus at the right moments.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ttfaPerTurn,
  lookupToSpeakLatency,
  totalCallDurationMs,
} from '../../../src/ai/voice-quality/audio/audio-timings';
import {
  transcriptReceivedEvent,
  audioFrameEmittedEvent,
} from '../../../src/ai/voice-quality/events';
import type { VoiceSessionEvent } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import {
  TwilioMediaStreamAdapter,
  type WsLike,
} from '../../../src/telephony/media-streams/mediastream-adapter';
import type {
  StreamingSession,
  StreamingTranscriptionProvider,
  StreamingTranscriptCallback,
} from '../../../src/voice/transcription-providers';
import type { TtsProvider, TtsSynthesizeResult } from '../../../src/ai/tts/tts-provider';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

describe('VQ2-004 audio-timings helpers', () => {
  it('VQ2-004 — ttfaPerTurn pairs transcript_received with next audio_frame_emitted', () => {
    const events: VoiceSessionEvent[] = [
      { type: 'transcript_received', ts: 1000 },
      { type: 'audio_frame_emitted', ts: 1250, byteCount: 640 },
    ];
    expect(ttfaPerTurn(events)).toEqual([250]);
  });

  it('VQ2-004 — ttfaPerTurn drops dangling transcript_received (no emitted audio)', () => {
    const events: VoiceSessionEvent[] = [
      { type: 'transcript_received', ts: 1000 },
      { type: 'transcript_received', ts: 5000 },
      { type: 'audio_frame_emitted', ts: 5400, byteCount: 320 },
    ];
    // First transcript at t=1000 has no following audio_frame_emitted
    // before the next transcript at t=5000 — by the helper contract it
    // is overwritten and the only paired turn is (5000 → 5400).
    expect(ttfaPerTurn(events)).toEqual([400]);
  });

  it('VQ2-004 — ttfaPerTurn handles multiple consecutive turns', () => {
    const events: VoiceSessionEvent[] = [
      { type: 'transcript_received', ts: 1000 },
      { type: 'audio_frame_emitted', ts: 1300, byteCount: 640 },
      { type: 'transcript_received', ts: 5000 },
      { type: 'audio_frame_emitted', ts: 5450, byteCount: 640 },
      { type: 'transcript_received', ts: 9000 },
      { type: 'audio_frame_emitted', ts: 9100, byteCount: 640 },
    ];
    expect(ttfaPerTurn(events)).toEqual([300, 450, 100]);
  });

  it('VQ2-004 — lookupToSpeakLatency pairs lookup_executed → audio_frame_emitted', () => {
    const events: VoiceSessionEvent[] = [
      { type: 'lookup_executed', skillName: 'find_customer', durationMs: 50, success: true, ts: 2000 },
      { type: 'audio_frame_emitted', ts: 2200, byteCount: 640 },
      { type: 'lookup_executed', skillName: 'find_invoice', durationMs: 30, success: true, ts: 6000 },
      { type: 'audio_frame_emitted', ts: 6125, byteCount: 640 },
    ];
    expect(lookupToSpeakLatency(events)).toEqual([200, 125]);
  });

  it('VQ2-004 — totalCallDurationMs returns 0 on empty events', () => {
    expect(totalCallDurationMs([])).toBe(0);
  });

  it('VQ2-004 — totalCallDurationMs returns end-start delta', () => {
    const events: VoiceSessionEvent[] = [
      { type: 'transcript_received', ts: 1000 },
      { type: 'audio_frame_emitted', ts: 1300, byteCount: 640 },
      { type: 'session_terminated', cause: 'completed', ts: 12345 },
    ];
    expect(totalCallDurationMs(events)).toBe(11345);
  });

  it('VQ2-004 — VoiceSessionEvent union includes transcript_received and audio_frame_emitted', () => {
    // Compile-time check: the discriminants must narrow.
    const t: VoiceSessionEvent = { type: 'transcript_received', ts: 1 };
    const a: VoiceSessionEvent = { type: 'audio_frame_emitted', ts: 2, byteCount: 99 };
    expect(t.type).toBe('transcript_received');
    expect(a.type).toBe('audio_frame_emitted');
    if (a.type === 'audio_frame_emitted') {
      // narrowing must give us byteCount
      expect(a.byteCount).toBe(99);
    }
  });

  it('VQ2-004 — events.ts constructors produce well-shaped events with monotonic ts', () => {
    const t1 = transcriptReceivedEvent({ ts: 100 });
    expect(t1).toEqual({ type: 'transcript_received', ts: 100 });

    const a1 = audioFrameEmittedEvent({ byteCount: 320, ts: 250 });
    expect(a1).toEqual({ type: 'audio_frame_emitted', byteCount: 320, ts: 250 });

    // No-ts overload defaults to Date.now() — assert the field exists
    // and is plausible (non-zero, near current wall clock).
    const before = Date.now();
    const t2 = transcriptReceivedEvent();
    const after = Date.now();
    expect(t2.ts).toBeGreaterThanOrEqual(before);
    expect(t2.ts).toBeLessThanOrEqual(after);

    const before2 = Date.now();
    const a2 = audioFrameEmittedEvent({ byteCount: 1 });
    const after2 = Date.now();
    expect(a2.ts).toBeGreaterThanOrEqual(before2);
    expect(a2.ts).toBeLessThanOrEqual(after2);
    expect(a2.byteCount).toBe(1);
  });
});

// ─── Adapter-level emit tests ────────────────────────────────────────────────

class FakeWs implements WsLike {
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  send(data: string): void {
    if (this.closed) return;
    try {
      this.sent.push(JSON.parse(data));
    } catch {
      this.sent.push({ raw: data });
    }
  }
  close(): void {
    this.closed = true;
    this.fire('close');
  }
  on(event: string, listener: (...args: unknown[]) => void): void {
    (this.listeners[event] ??= []).push(listener);
  }
  fire(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners[event] ?? []) listener(...args);
  }
  inboundJson(envelope: Record<string, unknown>): void {
    this.fire('message', Buffer.from(JSON.stringify(envelope)));
  }
}

interface FakeStreamingHandle {
  emit: StreamingTranscriptCallback;
}

function makeStreamingProvider(): { provider: StreamingTranscriptionProvider; handle: FakeStreamingHandle } {
  const handle: FakeStreamingHandle = {
    emit: () => {
      throw new Error('streamingProvider not opened yet');
    },
  };
  const provider: StreamingTranscriptionProvider = {
    async openSession(onEvent): Promise<StreamingSession> {
      handle.emit = onEvent;
      return {
        send: vi.fn(),
        finish: vi.fn(),
        destroy: vi.fn(),
      };
    },
  };
  return { provider, handle };
}

function makeTtsProvider(audio: Buffer): TtsProvider {
  return {
    async synthesize(): Promise<TtsSynthesizeResult> {
      return { audio, contentType: 'audio/pcm', provider: 'fake' };
    },
  };
}

describe('VQ2-004 mediastream-adapter emit sites', () => {
  let store: VoiceSessionStore;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
  });

  it('VQ2-004 — mediastream-adapter emits transcript_received when Whisper returns final transcript', async () => {
    const session = store.create('tenant-Z', 'telephony', { callSid: 'CA-tr' });
    const observed: VoiceSessionEvent[] = [];
    session.events.on('voice-event', (e: VoiceSessionEvent) => observed.push(e));

    const ws = new FakeWs();
    const { provider, handle } = makeStreamingProvider();
    const speechTurn = vi.fn().mockResolvedValue([] as SideEffect[]);
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: provider, speechTurn },
      ws,
    );
    adapter.start();

    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-tr',
      start: { callSid: 'CA-tr', accountSid: 'AC', streamSid: 'MZ-tr', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));

    handle.emit({ type: 'final', isFinal: true, transcript: 'hello there', confidence: 0.99 });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const transcripts = observed.filter((e) => e.type === 'transcript_received');
    expect(transcripts.length).toBe(1);
    expect(transcripts[0].ts).toBeGreaterThan(0);
    // Confirm we did NOT emit on partial frames either:
    handle.emit({ type: 'partial', isFinal: false, transcript: 'p', confidence: 0.5 });
    await new Promise((r) => setImmediate(r));
    expect(observed.filter((e) => e.type === 'transcript_received').length).toBe(1);
  });

  it('VQ2-004 — mediastream-adapter emits audio_frame_emitted ONCE per turn on first outbound frame', async () => {
    store.create('tenant-Z', 'telephony', { callSid: 'CA-af' });
    const sessionRef = store.findByCallSid('CA-af')!;
    const observed: VoiceSessionEvent[] = [];
    sessionRef.events.on('voice-event', (e: VoiceSessionEvent) => observed.push(e));

    const ws = new FakeWs();
    const { provider, handle } = makeStreamingProvider();
    // Big enough TTS buffer that streamPcmAsMedia produces many chunks.
    const ttsAudio = Buffer.alloc(640 * 5); // 5 frames worth
    const speechTurn = vi.fn().mockResolvedValue([
      { type: 'tts_play', payload: { text: 'Hi there' } },
    ] as SideEffect[]);
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: provider, ttsProvider: makeTtsProvider(ttsAudio), speechTurn },
      ws,
    );
    adapter.start();

    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-af',
      start: { callSid: 'CA-af', accountSid: 'AC', streamSid: 'MZ-af', tracks: ['inbound'] },
    });
    await new Promise((r) => setImmediate(r));

    handle.emit({ type: 'final', isFinal: true, transcript: 'order pizza', confidence: 0.95 });
    // Allow speechTurn → emitSideEffects → streamPcmAsMedia to run.
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));

    const frames = observed.filter((e) => e.type === 'audio_frame_emitted');
    expect(frames.length).toBe(1);
    if (frames[0].type === 'audio_frame_emitted') {
      expect(frames[0].byteCount).toBeGreaterThan(0);
      expect(frames[0].ts).toBeGreaterThan(0);
    }
    // Sanity: many media frames went out, but only one event was emitted.
    const mediaOut = ws.sent.filter((m) => m.event === 'media');
    expect(mediaOut.length).toBeGreaterThan(1);

    // Now drive a second turn → a second audio_frame_emitted should fire.
    handle.emit({ type: 'final', isFinal: true, transcript: 'one more thing', confidence: 0.95 });
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
    const framesAfter = observed.filter((e) => e.type === 'audio_frame_emitted');
    expect(framesAfter.length).toBe(2);
  });
});
