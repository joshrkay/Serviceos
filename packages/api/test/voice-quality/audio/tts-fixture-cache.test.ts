/**
 * VQ2-002 — TtsFixtureCache tests.
 *
 * The cache wraps a TtsProvider with content-addressable disk storage so
 * the Layer 2 audio-mode driver doesn't burn $0.30/script regenerating
 * the same caller utterance every run. These tests assert the cache hit
 * path, miss path, voice keying, cost tracking, and write-lock
 * serialization without ever touching the real OpenAI API.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  TtsFixtureCache,
  TTS_CENTS_PER_1K_CHARS,
  SUPPORTED_VOICES,
  defaultFixturesDir,
  pickVoiceForScript,
  type SupportedVoice,
} from '../../../src/ai/voice-quality/audio/tts-fixture-cache';
import type {
  TtsProvider,
  TtsSynthesizeInput,
  TtsSynthesizeResult,
} from '../../../src/ai/tts/tts-provider';

class MockCostTracker {
  total = 0;
  readonly addCents = vi.fn((n: number) => {
    this.total += n;
  });
}

/**
 * Build a TtsProvider whose `synthesize` returns deterministic bytes
 * derived from the input — different `(text, voice)` tuples produce
 * distinguishable buffers so collision tests are unambiguous.
 */
function makeFakeTtsProvider(
  impl?: (input: TtsSynthesizeInput) => Promise<TtsSynthesizeResult>
): TtsProvider & { synthesize: ReturnType<typeof vi.fn> } {
  const synthesize = vi.fn(
    impl ??
      (async (input: TtsSynthesizeInput) => ({
        audio: Buffer.from(`audio:${input.voice}:${input.text}`, 'utf-8'),
        contentType: 'audio/mpeg',
        provider: 'fake-tts',
      }))
  );
  return { synthesize } as unknown as TtsProvider & {
    synthesize: ReturnType<typeof vi.fn>;
  };
}

describe('VQ2-002 — TtsFixtureCache', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = path.join(os.tmpdir(), `tts-fixture-cache-${randomUUID()}`);
  });

  afterEach(() => {
    // Best-effort cleanup; ignore failures (e.g. test never wrote anything).
    try {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('VQ2-002 — getOrSynthesize calls ttsProvider on cache miss, returns Buffer', async () => {
    const ttsProvider = makeFakeTtsProvider();
    const cache = new TtsFixtureCache({ ttsProvider, cacheDir });

    const result = await cache.getOrSynthesize({
      text: 'Hi I have an appointment tomorrow',
      voice: 'alloy',
    });

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(ttsProvider.synthesize).toHaveBeenCalledTimes(1);
    // The provider was asked for the right text + voice.
    const call = ttsProvider.synthesize.mock.calls[0]![0] as TtsSynthesizeInput;
    expect(call.text).toBe('Hi I have an appointment tomorrow');
    expect(call.voice).toBe('alloy');
  });

  it('VQ2-002 — getOrSynthesize hits cache on second call (no second TTS call)', async () => {
    const ttsProvider = makeFakeTtsProvider();
    const cache = new TtsFixtureCache({ ttsProvider, cacheDir });

    const first = await cache.getOrSynthesize({
      text: 'Same utterance twice',
      voice: 'alloy',
    });
    const second = await cache.getOrSynthesize({
      text: 'Same utterance twice',
      voice: 'alloy',
    });

    expect(ttsProvider.synthesize).toHaveBeenCalledTimes(1);
    expect(second.equals(first)).toBe(true);
  });

  it('VQ2-002 — different voice for same text → different hash, different file (no collision)', async () => {
    const ttsProvider = makeFakeTtsProvider();
    const cache = new TtsFixtureCache({ ttsProvider, cacheDir });

    const a = await cache.getOrSynthesize({ text: 'Hello there', voice: 'alloy' });
    const b = await cache.getOrSynthesize({ text: 'Hello there', voice: 'nova' });

    expect(ttsProvider.synthesize).toHaveBeenCalledTimes(2);
    // The fake provider encodes voice in the bytes, so different voices
    // produce different buffers — confirms each landed in its own cache slot.
    expect(a.equals(b)).toBe(false);

    // And both files are present on disk under distinct hashes.
    const files = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.wav'));
    expect(files).toHaveLength(2);
  });

  it('VQ2-002 — costTracker.addCents called with derived cents on synthesis', async () => {
    const ttsProvider = makeFakeTtsProvider();
    const costTracker = new MockCostTracker();
    const cache = new TtsFixtureCache({ ttsProvider, costTracker, cacheDir });

    // 1000 chars → exactly TTS_CENTS_PER_1K_CHARS, ceil applied.
    const text = 'a'.repeat(1000);
    await cache.getOrSynthesize({ text, voice: 'alloy' });

    expect(costTracker.addCents).toHaveBeenCalledTimes(1);
    expect(costTracker.addCents).toHaveBeenCalledWith(
      Math.ceil(TTS_CENTS_PER_1K_CHARS)
    );
    expect(costTracker.total).toBe(Math.ceil(TTS_CENTS_PER_1K_CHARS));
  });

  it('VQ2-002 — costTracker NOT called on cache hit', async () => {
    const ttsProvider = makeFakeTtsProvider();
    const costTracker = new MockCostTracker();
    const cache = new TtsFixtureCache({ ttsProvider, costTracker, cacheDir });

    await cache.getOrSynthesize({ text: 'cached please', voice: 'alloy' });
    costTracker.addCents.mockClear();

    await cache.getOrSynthesize({ text: 'cached please', voice: 'alloy' });

    expect(costTracker.addCents).not.toHaveBeenCalled();
  });

  it('VQ2-002 — concurrent calls for same key serialize via lock (one TTS call total)', async () => {
    // Slow synth so two concurrent calls overlap; the lock + cache
    // existence check should still produce exactly one underlying call.
    let inFlight = 0;
    let maxInFlight = 0;
    const ttsProvider = makeFakeTtsProvider(async (input) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight -= 1;
      return {
        audio: Buffer.from(`audio:${input.voice}:${input.text}`, 'utf-8'),
        contentType: 'audio/mpeg',
        provider: 'fake-tts',
      };
    });
    const cache = new TtsFixtureCache({ ttsProvider, cacheDir });

    const opts = { text: 'concurrent test', voice: 'alloy' as SupportedVoice };
    const [a, b] = await Promise.all([
      cache.getOrSynthesize(opts),
      cache.getOrSynthesize(opts),
    ]);

    expect(ttsProvider.synthesize).toHaveBeenCalledTimes(1);
    expect(maxInFlight).toBeLessThanOrEqual(1);
    expect(a.equals(b)).toBe(true);
  });

  it('VQ2-002 — pickVoiceForScript rotates through alloy/nova/onyx deterministically', () => {
    expect(pickVoiceForScript(0)).toBe('alloy');
    expect(pickVoiceForScript(1)).toBe('nova');
    expect(pickVoiceForScript(2)).toBe('onyx');
    expect(pickVoiceForScript(3)).toBe('alloy');
    expect(pickVoiceForScript(7)).toBe(SUPPORTED_VOICES[7 % SUPPORTED_VOICES.length]);
  });

  it('VQ2-002 — defaultFixturesDir resolves under corpus/audio-fixtures', () => {
    const dir = defaultFixturesDir();
    // Must end with the canonical relative path, regardless of how the
    // build resolves __dirname (src/ vs dist/).
    expect(dir.replace(/\\/g, '/')).toMatch(
      /voice-quality\/corpus\/audio-fixtures$/
    );
  });
});
