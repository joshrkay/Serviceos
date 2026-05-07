/**
 * confirm_intent skill tests.
 *
 * The skill reads back an intent summary via TTS, then classifies the
 * caller's response as confirmed or a correction using the LLM gateway.
 *
 * Key invariants:
 * - Affirmative responses → confirmed: true
 * - Negative / corrective / ambiguous responses → confirmed: false, correction populated
 * - Ambiguous is treated as correction (safe default)
 * - TTS failure is non-fatal (result returned without audio)
 * - Gateway timeout propagates as thrown error (caller handles retry)
 */

import { describe, it, expect, vi } from 'vitest';
import { confirmIntent, ConfirmIntentInput } from '../../../src/ai/skills/confirm-intent';
import { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import { TtsProvider, TtsSynthesizeResult } from '../../../src/ai/tts/tts-provider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockGateway(answer: 'yes' | 'no', reasoning = 'test'): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: JSON.stringify({ answer, reasoning }),
      model: 'mock-model',
      provider: 'mock',
      tokenUsage: { input: 50, output: 20, total: 70 },
      latencyMs: 12,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

function mockTtsProvider(audioBytes: Buffer = Buffer.from('fake-audio')): TtsProvider {
  return {
    synthesize: vi.fn(async () => ({
      audio: audioBytes,
      contentType: 'audio/mpeg',
      provider: 'mock-tts',
    } satisfies TtsSynthesizeResult)),
  };
}

function failingTtsProvider(): TtsProvider {
  return {
    synthesize: vi.fn(async () => {
      throw new Error('TTS service unavailable');
    }),
  };
}

function baseInput(overrides: Partial<ConfirmIntentInput> = {}): ConfirmIntentInput {
  return {
    intentSummary: 'schedule an AC diagnostic for Friday 2pm for Johnson residence',
    callerResponse: 'yes',
    tenantId: 'tenant-1',
    gateway: mockGateway('yes'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Affirmative responses
// ---------------------------------------------------------------------------

describe('confirmIntent — affirmative responses', () => {
  it('"yes" → confirmed: true', async () => {
    const result = await confirmIntent(baseInput({ callerResponse: 'yes' }));
    expect(result.confirmed).toBe(true);
    expect(result.correction).toBeUndefined();
  });

  it('"yep, that\'s right" → confirmed: true', async () => {
    const result = await confirmIntent(baseInput({
      callerResponse: "yep, that's right",
      gateway: mockGateway('yes', 'caller affirmed'),
    }));
    expect(result.confirmed).toBe(true);
    expect(result.correction).toBeUndefined();
  });

  it('"correct" → confirmed: true', async () => {
    const result = await confirmIntent(baseInput({
      callerResponse: 'correct',
      gateway: mockGateway('yes'),
    }));
    expect(result.confirmed).toBe(true);
  });

  it('"sounds good, go ahead" → confirmed: true', async () => {
    const result = await confirmIntent(baseInput({
      callerResponse: 'sounds good, go ahead',
      gateway: mockGateway('yes'),
    }));
    expect(result.confirmed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Negative / corrective responses
// ---------------------------------------------------------------------------

describe('confirmIntent — negative and corrective responses', () => {
  it('"no, I said Thursday not Friday" → confirmed: false, correction populated', async () => {
    const callerResponse = 'no, I said Thursday not Friday';
    const result = await confirmIntent(baseInput({
      callerResponse,
      gateway: mockGateway('no', 'caller corrected the day'),
    }));
    expect(result.confirmed).toBe(false);
    expect(result.correction).toBe(callerResponse);
  });

  it('"actually, it\'s for the Smith account" → confirmed: false, correction populated', async () => {
    const callerResponse = "actually, it's for the Smith account";
    const result = await confirmIntent(baseInput({
      callerResponse,
      gateway: mockGateway('no', 'caller corrected the account'),
    }));
    expect(result.confirmed).toBe(false);
    expect(result.correction).toBe(callerResponse);
  });

  it('"no" → confirmed: false, correction is the raw response', async () => {
    const result = await confirmIntent(baseInput({
      callerResponse: 'no',
      gateway: mockGateway('no'),
    }));
    expect(result.confirmed).toBe(false);
    expect(result.correction).toBe('no');
  });

  it('"wait, that\'s not right" → confirmed: false', async () => {
    const callerResponse = "wait, that's not right";
    const result = await confirmIntent(baseInput({
      callerResponse,
      gateway: mockGateway('no'),
    }));
    expect(result.confirmed).toBe(false);
    expect(result.correction).toBe(callerResponse);
  });
});

// ---------------------------------------------------------------------------
// Ambiguous response — safe default is correction
// ---------------------------------------------------------------------------

describe('confirmIntent — ambiguous response treated as correction', () => {
  it('LLM returning "no" for an ambiguous phrase → confirmed: false', async () => {
    const callerResponse = 'um, I think so maybe';
    const result = await confirmIntent(baseInput({
      callerResponse,
      // Gateway classifies ambiguous as "no" (safe default in prompt)
      gateway: mockGateway('no', 'ambiguous — defaulting to no for safety'),
    }));
    expect(result.confirmed).toBe(false);
    expect(result.correction).toBe(callerResponse);
  });

  it('unparseable gateway JSON → confirmed: false (safe default)', async () => {
    const callerResponse = 'hmm';
    const gateway = {
      complete: vi.fn(async () => ({
        content: 'not valid json at all',
        model: 'mock-model',
        provider: 'mock',
        tokenUsage: { input: 10, output: 5, total: 15 },
        latencyMs: 5,
      } satisfies LLMResponse)),
    } as unknown as LLMGateway;

    const result = await confirmIntent(baseInput({ callerResponse, gateway }));
    expect(result.confirmed).toBe(false);
    expect(result.correction).toBe(callerResponse);
  });

  it('gateway returns unexpected "answer" value → confirmed: false (safe default)', async () => {
    const callerResponse = 'perhaps';
    const gateway = {
      complete: vi.fn(async () => ({
        content: JSON.stringify({ answer: 'maybe', reasoning: 'uncertain' }),
        model: 'mock-model',
        provider: 'mock',
        tokenUsage: { input: 10, output: 5, total: 15 },
        latencyMs: 5,
      } satisfies LLMResponse)),
    } as unknown as LLMGateway;

    const result = await confirmIntent(baseInput({ callerResponse, gateway }));
    expect(result.confirmed).toBe(false);
    expect(result.correction).toBe(callerResponse);
  });
});

// ---------------------------------------------------------------------------
// TTS provider present → readbackAudio populated
// ---------------------------------------------------------------------------

describe('confirmIntent — TTS integration', () => {
  it('when ttsProvider is provided, readbackAudio is populated', async () => {
    const audioBytes = Buffer.from('mp3-bytes');
    const ttsProvider = mockTtsProvider(audioBytes);

    const result = await confirmIntent(baseInput({
      ttsProvider,
      gateway: mockGateway('yes'),
    }));

    expect(result.readbackAudio).toBeDefined();
    expect(result.readbackAudio).toEqual(audioBytes);
  });

  it('TTS is called with the correct readback text', async () => {
    const ttsProvider = mockTtsProvider();
    const intentSummary = 'schedule an AC diagnostic for Friday 2pm for Johnson residence';

    await confirmIntent(baseInput({ ttsProvider, intentSummary, gateway: mockGateway('yes') }));

    expect(ttsProvider.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        text: `Just to confirm — ${intentSummary}. Is that right?`,
        tenantId: 'tenant-1',
      })
    );
  });

  it('when ttsProvider is absent, readbackAudio is undefined', async () => {
    const result = await confirmIntent(baseInput({ gateway: mockGateway('yes') }));
    expect(result.readbackAudio).toBeUndefined();
  });

  it('TTS failure is gracefully degraded — result returned without audio', async () => {
    const result = await confirmIntent(baseInput({
      ttsProvider: failingTtsProvider(),
      gateway: mockGateway('yes'),
    }));

    // Skill should still return a result
    expect(result.confirmed).toBe(true);
    // But without audio
    expect(result.readbackAudio).toBeUndefined();
  });

  it('TTS failure does not affect confirmation classification', async () => {
    const callerResponse = 'no, wrong day';
    const result = await confirmIntent(baseInput({
      callerResponse,
      ttsProvider: failingTtsProvider(),
      gateway: mockGateway('no'),
    }));

    expect(result.confirmed).toBe(false);
    expect(result.correction).toBe(callerResponse);
    expect(result.readbackAudio).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gateway timeout / error → propagates to caller
// ---------------------------------------------------------------------------

describe('confirmIntent — gateway error propagation', () => {
  it('gateway timeout → throws (caller handles retry/escalation)', async () => {
    const gateway = {
      complete: vi.fn(async () => {
        throw new Error('Gateway timeout');
      }),
    } as unknown as LLMGateway;

    await expect(
      confirmIntent(baseInput({ gateway }))
    ).rejects.toThrow('Gateway timeout');
  });

  it('gateway provider error → propagates the original error', async () => {
    const gateway = {
      complete: vi.fn(async () => {
        const err = Object.assign(new Error('Provider unavailable'), { code: 'LLM_PROVIDER_ERROR' });
        throw err;
      }),
    } as unknown as LLMGateway;

    await expect(
      confirmIntent(baseInput({ gateway }))
    ).rejects.toMatchObject({ message: 'Provider unavailable' });
  });
});

// ---------------------------------------------------------------------------
// Gateway call shape verification
// ---------------------------------------------------------------------------

describe('confirmIntent — gateway call shape', () => {
  it('sends taskType: classify_intent for cheap model routing', async () => {
    const gateway = mockGateway('yes');
    await confirmIntent(baseInput({ gateway }));

    expect(gateway.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: 'classify_intent',
        responseFormat: 'json',
        temperature: 0,
      })
    );
  });

  it('includes tenantId in metadata for cost accounting', async () => {
    const gateway = mockGateway('yes');
    await confirmIntent(baseInput({ tenantId: 'tenant-abc', gateway }));

    expect(gateway.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ tenantId: 'tenant-abc' }),
      })
    );
  });

  it('readback text embeds the intentSummary verbatim', async () => {
    const gateway = mockGateway('yes');
    const intentSummary = 'reschedule the Miller job to Thursday at 3pm';
    await confirmIntent(baseInput({ intentSummary, gateway }));

    const callArg = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userMessage = callArg.messages.find((m: { role: string }) => m.role === 'user');
    expect(userMessage.content).toContain(intentSummary);
    expect(userMessage.content).toContain('Just to confirm —');
    expect(userMessage.content).toContain('Is that right?');
  });
});
