/**
 * UB-C2 — createTtsProvider factory pins.
 *
 * The streaming call path renders pre-cut filler clips (rendered by
 * scripts/render-fillers.ts with ELEVENLABS_VOICE_ID) interleaved with
 * live ElevenLabs TTS. Both must speak with ONE voice, so the factory
 * must honor the same ELEVENLABS_VOICE_ID the render script uses.
 */
import { describe, it, expect } from 'vitest';
import {
  createTtsProvider,
  ElevenLabsTtsProvider,
  OpenAiTtsProvider,
} from '../../../src/ai/tts/tts-provider';

describe('UB-C2 — createTtsProvider', () => {
  it('threads ELEVENLABS_VOICE_ID into the ElevenLabs provider (filler/live voice parity)', () => {
    const provider = createTtsProvider({
      TTS_PROVIDER: 'elevenlabs',
      ELEVENLABS_API_KEY: 'key',
      ELEVENLABS_VOICE_ID: 'CustomVoice12345',
    });
    expect(provider).toBeInstanceOf(ElevenLabsTtsProvider);
    // voiceId is a constructor-private field; pin it via reflection so a
    // regression back to the hardcoded default is caught.
    expect((provider as unknown as { voiceId: string }).voiceId).toBe('CustomVoice12345');
  });

  it('falls back to the default voice when ELEVENLABS_VOICE_ID is unset', () => {
    const provider = createTtsProvider({
      TTS_PROVIDER: 'elevenlabs',
      ELEVENLABS_API_KEY: 'key',
    });
    expect(provider).toBeInstanceOf(ElevenLabsTtsProvider);
    expect((provider as unknown as { voiceId: string }).voiceId).toBe('21m00Tcm4TlvDq8ikWAM');
  });

  it('returns undefined without an ElevenLabs key, and OpenAI otherwise', () => {
    expect(
      createTtsProvider({ TTS_PROVIDER: 'elevenlabs' }),
    ).toBeUndefined();
    expect(
      createTtsProvider({ AI_PROVIDER_API_KEY: 'openai-key' }),
    ).toBeInstanceOf(OpenAiTtsProvider);
  });
});
