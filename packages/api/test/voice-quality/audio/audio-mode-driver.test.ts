/**
 * VQ2-008 — AudioModeDriver tests.
 *
 * The AudioModeDriver wires the Layer 2 audio loop together: synthesize
 * caller TTS → stream μ-law frames into the production media-streams
 * server via {@link TwilioStreamEmulator} → collect agent audio →
 * Whisper-decode it → return the transcript through the same
 * {@link AgentDriver} contract Layer 1's TextModeDriver implements.
 *
 * These are unit tests. The emulator, Whisper provider, TTS cache, and
 * MP3 decoder are all mocked — we don't run ffmpeg, we don't open any
 * sockets, we don't talk to OpenAI. The MP3-decode step is injected via
 * the optional `decodeTtsAudio` dep so we can swap in a synchronous
 * Buffer pass-through in tests without intercepting dynamic imports.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  AudioModeDriver,
  type AudioModeDriverDeps,
} from '../../../src/ai/voice-quality/audio/audio-mode-driver';
import { AgentEventBus } from '../../../src/ai/voice-quality/event-bus';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import type { TurnResult, TwilioStreamEmulator } from '../../../src/ai/voice-quality/audio/twilio-stream-emulator';
import type { WhisperRealProvider } from '../../../src/ai/voice-quality/audio/whisper-real-provider';
import type { TtsFixtureCache } from '../../../src/ai/voice-quality/audio/tts-fixture-cache';

// ─── Mock factories ─────────────────────────────────────────────────────────

interface MockEmulator {
  start: ReturnType<typeof vi.fn>;
  sendCallerUtterance: ReturnType<typeof vi.fn>;
  hangup: ReturnType<typeof vi.fn>;
}

function makeMockEmulator(turnResult: Partial<TurnResult> = {}): MockEmulator {
  const defaultTurn: TurnResult = {
    agentAudio: Buffer.from('AGENT_PCM'),
    ttfaMs: 123,
    numFrames: 5,
    totalBytesIn: 800,
    ...turnResult,
  };
  return {
    start: vi.fn().mockResolvedValue(undefined),
    sendCallerUtterance: vi.fn().mockResolvedValue(defaultTurn),
    hangup: vi.fn().mockResolvedValue(undefined),
  };
}

interface MockWhisper {
  transcribeBuffer: ReturnType<typeof vi.fn>;
}

function makeMockWhisper(transcript = 'agent reply transcript'): MockWhisper {
  return {
    transcribeBuffer: vi.fn().mockResolvedValue(transcript),
  };
}

interface MockTtsCache {
  getOrSynthesize: ReturnType<typeof vi.fn>;
}

function makeMockTtsCache(audio: Buffer = Buffer.from('MP3_BYTES')): MockTtsCache {
  return {
    getOrSynthesize: vi.fn().mockResolvedValue(audio),
  };
}

function makeDeps(overrides: Partial<AudioModeDriverDeps> = {}): {
  deps: AudioModeDriverDeps;
  emulator: MockEmulator;
  whisper: MockWhisper;
  ttsCache: MockTtsCache;
  bus: AgentEventBus;
  voiceSessionStore: VoiceSessionStore;
  decodeTtsAudio: ReturnType<typeof vi.fn>;
} {
  const emulator = makeMockEmulator();
  const whisper = makeMockWhisper();
  const ttsCache = makeMockTtsCache();
  const bus = new AgentEventBus();
  // startInterval: false so vitest doesn't see a leaked timer.
  const voiceSessionStore = new VoiceSessionStore({ startInterval: false });
  // Synchronous decoder stub — pass-through that returns a deterministic
  // PCM-shaped buffer. Avoids invoking ffmpeg in unit tests.
  const decodeTtsAudio = vi.fn().mockImplementation(async (mp3: Buffer) =>
    Buffer.concat([Buffer.from('PCM:'), mp3]),
  );

  const deps: AudioModeDriverDeps = {
    emulator: emulator as unknown as TwilioStreamEmulator,
    whisper: whisper as unknown as WhisperRealProvider,
    ttsCache: ttsCache as unknown as TtsFixtureCache,
    bus,
    voiceSessionStore,
    decodeTtsAudio,
    ...overrides,
  };

  return { deps, emulator, whisper, ttsCache, bus, voiceSessionStore, decodeTtsAudio };
}

const START_OPTS = {
  tenantId: 'tenant-1',
  callerId: '+15551112222',
  callerIdBlocked: false,
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('VQ2-008 — AudioModeDriver', () => {
  let cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) fn();
    cleanups = [];
  });

  it('VQ2-008 — startSession creates a sessionId, pre-seeds voiceSessionStore, opens emulator', async () => {
    const { deps, emulator, voiceSessionStore } = makeDeps();
    cleanups.push(() => voiceSessionStore.dispose());
    const driver = new AudioModeDriver(deps);

    const { sessionId } = await driver.startSession(START_OPTS);

    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);
    // The session was actually written to the store and is findable.
    const session = voiceSessionStore.peek(sessionId);
    expect(session).toBeDefined();
    expect(session!.tenantId).toBe('tenant-1');
    expect(session!.callSid).toBeDefined();
    // CallSid uses the unambiguous CA_TEST_ prefix (real Twilio CallSids
    // start with `CA` + a hex blob, so this is distinguishable).
    expect(session!.callSid).toMatch(/^CA_TEST_/);
    // findByCallSid resolves the same session — confirms the production
    // server's WS-handshake lookup will succeed.
    expect(voiceSessionStore.findByCallSid(session!.callSid!)?.id).toBe(sessionId);

    // Emulator was opened with the matching CallSid.
    expect(emulator.start).toHaveBeenCalledTimes(1);
    expect(emulator.start).toHaveBeenCalledWith(session!.callSid);
  });

  it('VQ2-008 — speak() synthesizes caller audio, decodes MP3 → PCM, streams via emulator, transcribes agent audio via Whisper', async () => {
    const { deps, emulator, whisper, ttsCache, decodeTtsAudio, voiceSessionStore } = makeDeps();
    cleanups.push(() => voiceSessionStore.dispose());
    const driver = new AudioModeDriver(deps);
    const { sessionId } = await driver.startSession(START_OPTS);

    await driver.speak(sessionId, 'hello agent');

    // 1. TTS cache called with the caller transcript.
    expect(ttsCache.getOrSynthesize).toHaveBeenCalledTimes(1);
    const ttsCall = ttsCache.getOrSynthesize.mock.calls[0]![0];
    expect(ttsCall.text).toBe('hello agent');
    expect(['alloy', 'nova', 'onyx']).toContain(ttsCall.voice);

    // 2. Decoded MP3 → PCM was forwarded to the emulator.
    expect(decodeTtsAudio).toHaveBeenCalledTimes(1);
    expect(emulator.sendCallerUtterance).toHaveBeenCalledTimes(1);
    const sendArgs = emulator.sendCallerUtterance.mock.calls[0]!;
    // First arg is the decoded PCM Buffer.
    expect(Buffer.isBuffer(sendArgs[0])).toBe(true);
    expect((sendArgs[0] as Buffer).toString()).toContain('PCM:');
    // Second arg is the per-turn index (starts at 0).
    expect(sendArgs[1]).toBe(0);

    // 3. Whisper got the emulator's agentAudio buffer.
    expect(whisper.transcribeBuffer).toHaveBeenCalledTimes(1);
    const whisperArgs = whisper.transcribeBuffer.mock.calls[0]!;
    expect(Buffer.isBuffer(whisperArgs[0])).toBe(true);
    expect((whisperArgs[0] as Buffer).toString()).toBe('AGENT_PCM');
    expect(typeof whisperArgs[1]).toBe('string');
  });

  it('VQ2-008 — speak() returns agentResponse from Whisper transcript and latencyMs from emulator.TurnResult', async () => {
    const { deps, voiceSessionStore } = makeDeps({});
    cleanups.push(() => voiceSessionStore.dispose());
    // Override Whisper + emulator to return known values.
    const whisper = makeMockWhisper('booked for Friday');
    const emulator = makeMockEmulator({ ttfaMs: 456 });
    const driver = new AudioModeDriver({
      ...deps,
      whisper: whisper as unknown as WhisperRealProvider,
      emulator: emulator as unknown as TwilioStreamEmulator,
    });

    const { sessionId } = await driver.startSession(START_OPTS);
    const result = await driver.speak(sessionId, 'book me for Friday');

    expect(result.agentResponse).toBe('booked for Friday');
    expect(result.latencyMs).toBe(456);
  });

  it('VQ2-008 — speak() rotates voices across turns when no voice is pinned', async () => {
    const { deps, ttsCache, voiceSessionStore } = makeDeps();
    cleanups.push(() => voiceSessionStore.dispose());
    const driver = new AudioModeDriver(deps);
    const { sessionId } = await driver.startSession(START_OPTS);

    await driver.speak(sessionId, 'turn 0');
    await driver.speak(sessionId, 'turn 1');
    await driver.speak(sessionId, 'turn 2');

    const calls = ttsCache.getOrSynthesize.mock.calls;
    expect(calls).toHaveLength(3);
    // pickVoiceForScript rotates alloy/nova/onyx by index → 3 distinct voices.
    const voices = calls.map((c) => c[0].voice);
    expect(new Set(voices).size).toBe(3);
    expect(voices).toEqual(['alloy', 'nova', 'onyx']);
  });

  it('VQ2-008 — speak() honours a pinned voice when deps.voice is set', async () => {
    const { deps, ttsCache, voiceSessionStore } = makeDeps({ voice: 'onyx' });
    cleanups.push(() => voiceSessionStore.dispose());
    const driver = new AudioModeDriver(deps);
    const { sessionId } = await driver.startSession(START_OPTS);

    await driver.speak(sessionId, 'turn 0');
    await driver.speak(sessionId, 'turn 1');

    const calls = ttsCache.getOrSynthesize.mock.calls;
    expect(calls.map((c) => c[0].voice)).toEqual(['onyx', 'onyx']);
  });

  it('VQ2-008 — speak() with empty agent audio returns agentResponse: "" (silent agent case)', async () => {
    const { deps, voiceSessionStore } = makeDeps();
    cleanups.push(() => voiceSessionStore.dispose());
    const emulator = makeMockEmulator({
      agentAudio: Buffer.alloc(0),
      ttfaMs: 0,
      numFrames: 0,
      totalBytesIn: 0,
    });
    const whisper = makeMockWhisper();
    const driver = new AudioModeDriver({
      ...deps,
      emulator: emulator as unknown as TwilioStreamEmulator,
      whisper: whisper as unknown as WhisperRealProvider,
    });

    const { sessionId } = await driver.startSession(START_OPTS);
    const result = await driver.speak(sessionId, 'are you there?');

    expect(result.agentResponse).toBe('');
    expect(result.latencyMs).toBe(0);
    // Whisper should NOT be invoked on a zero-length buffer.
    expect(whisper.transcribeBuffer).not.toHaveBeenCalled();
  });

  it('VQ2-008 — speak() with mismatched sessionId throws clear error', async () => {
    const { deps, voiceSessionStore } = makeDeps();
    cleanups.push(() => voiceSessionStore.dispose());
    const driver = new AudioModeDriver(deps);
    await driver.startSession(START_OPTS);

    await expect(driver.speak('not-the-real-session-id', 'hi')).rejects.toThrow(
      /mismatched sessionId/i,
    );
  });

  it('VQ2-008 — speak() handles Whisper transcription failure gracefully (returns empty agentResponse, does not throw)', async () => {
    const { deps, voiceSessionStore } = makeDeps();
    cleanups.push(() => voiceSessionStore.dispose());
    const whisper: MockWhisper = {
      transcribeBuffer: vi.fn().mockRejectedValue(new Error('whisper exploded')),
    };
    const driver = new AudioModeDriver({
      ...deps,
      whisper: whisper as unknown as WhisperRealProvider,
    });

    const { sessionId } = await driver.startSession(START_OPTS);
    const result = await driver.speak(sessionId, 'utterance that triggers a whisper fail');

    expect(result.agentResponse).toBe('');
    expect(typeof result.latencyMs).toBe('number');
    expect(whisper.transcribeBuffer).toHaveBeenCalledTimes(1);
  });

  it('VQ2-008 — hangup forwards to emulator.hangup', async () => {
    const { deps, emulator, voiceSessionStore } = makeDeps();
    cleanups.push(() => voiceSessionStore.dispose());
    const driver = new AudioModeDriver(deps);
    const { sessionId } = await driver.startSession(START_OPTS);

    await driver.hangup(sessionId);

    expect(emulator.hangup).toHaveBeenCalledTimes(1);
  });

  it('VQ2-008 — hangup with mismatched sessionId is a no-op (does not call emulator.hangup)', async () => {
    const { deps, emulator, voiceSessionStore } = makeDeps();
    cleanups.push(() => voiceSessionStore.dispose());
    const driver = new AudioModeDriver(deps);
    await driver.startSession(START_OPTS);

    await driver.hangup('some-other-session');

    expect(emulator.hangup).not.toHaveBeenCalled();
  });

  it('VQ2-008 — endSession clears the current sessionId and removes the session from the store', async () => {
    const { deps, voiceSessionStore } = makeDeps();
    cleanups.push(() => voiceSessionStore.dispose());
    const driver = new AudioModeDriver(deps);
    const { sessionId } = await driver.startSession(START_OPTS);

    expect(voiceSessionStore.peek(sessionId)).toBeDefined();
    await driver.endSession(sessionId);
    expect(voiceSessionStore.peek(sessionId)).toBeUndefined();

    // After endSession, a follow-up speak() against the same id is rejected
    // by the mismatched-sessionId guard (currentSessionId was cleared).
    await expect(driver.speak(sessionId, 'should fail')).rejects.toThrow(
      /mismatched sessionId/i,
    );
  });

  it('VQ2-008 — turn index increments across calls so emulator sees 0, 1, 2 …', async () => {
    const { deps, emulator, voiceSessionStore } = makeDeps();
    cleanups.push(() => voiceSessionStore.dispose());
    const driver = new AudioModeDriver(deps);
    const { sessionId } = await driver.startSession(START_OPTS);

    await driver.speak(sessionId, 'a');
    await driver.speak(sessionId, 'b');
    await driver.speak(sessionId, 'c');

    expect(emulator.sendCallerUtterance.mock.calls.map((c) => c[1])).toEqual([0, 1, 2]);
  });
});
