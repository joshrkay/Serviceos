/**
 * VQ2-001 — WhisperRealProvider tests.
 *
 * The wrapper composes a buffer-capable Whisper inner with cost
 * accounting + bounded 429 retry + observability via the AgentEventBus.
 * These tests assert each axis independently against a mock inner so we
 * don't talk to OpenAI in CI.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentEventBus } from '../../../src/ai/voice-quality/event-bus';
import {
  WhisperRealProvider,
  WHISPER_CENTS_PER_MINUTE,
  type WhisperBufferTranscriber,
  type WhisperCostTracker,
} from '../../../src/ai/voice-quality/audio/whisper-real-provider';

class MockCostTracker implements WhisperCostTracker {
  private total = 0;
  readonly addCents = vi.fn((n: number) => {
    this.total += n;
  });
  totalCents(): number {
    return this.total;
  }
}

/**
 * 1 second of "audio" at the 16-bit PCM mono 8 kHz heuristic
 * (telephony-standard, post-VQ2-003). The estimator divides
 * `audio.length` by 16 000 to derive seconds.
 */
function oneSecondAudio(): Buffer {
  return Buffer.alloc(16_000, 0);
}

/** 60 seconds of "audio" → exactly 0.6 cents per the constant. */
function oneMinuteAudio(): Buffer {
  return Buffer.alloc(16_000 * 60, 0);
}

/** Build a 429-shaped error consumers (e.g. the OpenAI SDK) typically throw. */
function rateLimitError(): Error & { status: number } {
  const err = new Error('rate limit exceeded') as Error & { status: number };
  err.status = 429;
  return err;
}

describe('VQ2-001 — WhisperRealProvider', () => {
  let bus: AgentEventBus;
  let costTracker: MockCostTracker;

  beforeEach(() => {
    bus = new AgentEventBus();
    costTracker = new MockCostTracker();
  });

  it('VQ2-001 — happy path: transcribeBuffer returns transcript on 200 response', async () => {
    const inner: WhisperBufferTranscriber = {
      transcribeBuffer: vi.fn().mockResolvedValue({
        transcript: 'hello world',
        metadata: { provider: 'openai-whisper' },
      }),
    };
    const provider = new WhisperRealProvider({ inner, bus, costTracker });

    const result = await provider.transcribeBuffer(oneSecondAudio(), 'script-1');

    expect(result).toBe('hello world');
    expect(inner.transcribeBuffer).toHaveBeenCalledTimes(1);
  });

  it('VQ2-001 — emits lookup_executed event with skillName whisper.transcribe and durationMs > 0', async () => {
    const inner: WhisperBufferTranscriber = {
      transcribeBuffer: vi.fn().mockImplementation(async () => {
        // Force a measurable delay so durationMs is unambiguously > 0.
        await new Promise((r) => setTimeout(r, 5));
        return { transcript: 'ok', metadata: {} };
      }),
    };
    const provider = new WhisperRealProvider({ inner, bus, costTracker });

    await provider.transcribeBuffer(oneSecondAudio(), 'script-1');

    const events = bus.filterByType('lookup_executed');
    expect(events).toHaveLength(1);
    expect(events[0]!.skillName).toBe('whisper.transcribe');
    expect(events[0]!.success).toBe(true);
    expect(events[0]!.durationMs).toBeGreaterThan(0);
  });

  it('VQ2-001 — addCents called with derived cents (audioSeconds / 60 * 0.6, ceiled)', async () => {
    const inner: WhisperBufferTranscriber = {
      transcribeBuffer: vi
        .fn()
        .mockResolvedValue({ transcript: 't', metadata: {} }),
    };
    const provider = new WhisperRealProvider({ inner, bus, costTracker });

    // 60 seconds of audio = 1 minute = WHISPER_CENTS_PER_MINUTE (0.6) → ceil = 1.
    await provider.transcribeBuffer(oneMinuteAudio(), 'script-1');

    expect(costTracker.addCents).toHaveBeenCalledTimes(1);
    expect(costTracker.addCents).toHaveBeenCalledWith(
      Math.ceil(WHISPER_CENTS_PER_MINUTE),
    );
    expect(costTracker.totalCents()).toBe(1);
  });

  it('VQ2-fix — pins bytes-per-sec heuristic at 16 kBps (telephony 8 kHz 16-bit PCM)', async () => {
    // Regression for PR #334 review (Gemini #2): the estimator must divide
    // by 16 000, not 32 000. A 16 000-byte buffer represents 1 second of
    // 8 kHz 16-bit PCM mono audio, so cost = ceil(1/60 * 0.6) = 1 cent.
    // If the estimator divides by 32 000, the same buffer bills 0 cents
    // (or 1 only because of ceil), and longer suites silently undercount.
    const inner: WhisperBufferTranscriber = {
      transcribeBuffer: vi
        .fn()
        .mockResolvedValue({ transcript: 't', metadata: {} }),
    };
    const provider = new WhisperRealProvider({ inner, bus, costTracker });

    // 16 000 bytes → 1 second @ 16 kBps. ceil(1/60 * 0.6) = 1 cent.
    await provider.transcribeBuffer(Buffer.alloc(16_000, 0), 'script-1');
    expect(costTracker.totalCents()).toBe(1);

    // 16 000 * 60 bytes → 60 seconds → 0.6 cents → ceil = 1 → cumulative 2.
    await provider.transcribeBuffer(Buffer.alloc(16_000 * 60, 0), 'script-1');
    expect(costTracker.totalCents()).toBe(2);
  });

  it('VQ2-001 — retries once on 429, then succeeds', async () => {
    const inner: WhisperBufferTranscriber = {
      transcribeBuffer: vi
        .fn()
        .mockRejectedValueOnce(rateLimitError())
        .mockResolvedValueOnce({ transcript: 'second time lucky', metadata: {} }),
    };
    const provider = new WhisperRealProvider({ inner, bus, costTracker });

    const result = await provider.transcribeBuffer(oneSecondAudio(), 'script-1');

    expect(result).toBe('second time lucky');
    expect(inner.transcribeBuffer).toHaveBeenCalledTimes(2);
    // Cost tracked exactly once on success — not per attempt.
    expect(costTracker.addCents).toHaveBeenCalledTimes(1);
  });

  it('VQ2-001 — fails after second 429 with the underlying error', async () => {
    const finalErr = rateLimitError();
    const inner: WhisperBufferTranscriber = {
      transcribeBuffer: vi
        .fn()
        .mockRejectedValueOnce(rateLimitError())
        .mockRejectedValueOnce(finalErr),
    };
    const provider = new WhisperRealProvider({ inner, bus, costTracker });

    await expect(
      provider.transcribeBuffer(oneSecondAudio(), 'script-1'),
    ).rejects.toBe(finalErr);
    expect(inner.transcribeBuffer).toHaveBeenCalledTimes(2);
    expect(costTracker.addCents).not.toHaveBeenCalled();
  });

  it('VQ2-001 — non-429 errors propagate immediately (no retry)', async () => {
    const fatal = new Error('bad request') as Error & { status: number };
    fatal.status = 400;
    const inner: WhisperBufferTranscriber = {
      transcribeBuffer: vi.fn().mockRejectedValue(fatal),
    };
    const provider = new WhisperRealProvider({ inner, bus, costTracker });

    await expect(
      provider.transcribeBuffer(oneSecondAudio(), 'script-1'),
    ).rejects.toBe(fatal);
    expect(inner.transcribeBuffer).toHaveBeenCalledTimes(1);
    expect(costTracker.addCents).not.toHaveBeenCalled();
  });

  it('VQ2-001 — emits lookup_executed event with success: false on failure', async () => {
    const fatal = new Error('boom') as Error & { status: number };
    fatal.status = 500;
    const inner: WhisperBufferTranscriber = {
      transcribeBuffer: vi.fn().mockRejectedValue(fatal),
    };
    const provider = new WhisperRealProvider({ inner, bus, costTracker });

    await expect(
      provider.transcribeBuffer(oneSecondAudio(), 'script-1'),
    ).rejects.toBe(fatal);

    const events = bus.filterByType('lookup_executed');
    expect(events).toHaveLength(1);
    expect(events[0]!.success).toBe(false);
    expect(events[0]!.skillName).toBe('whisper.transcribe');
    expect(events[0]!.error).toBe('boom');
  });
});
