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
  assertTtsProviderSupportsMediaStreams,
  ElevenLabsTtsProvider,
  OpenAiTtsProvider,
  type TtsProvider,
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

/**
 * P0 voice-output bug — Twilio Media Streams requires raw PCM
 * (synthesizeStream); a provider that only implements synthesize()
 * (OpenAI tts-1, the default TTS_PROVIDER) returns compressed audio
 * (mp3), which mediastream-adapter.ts would previously stream out as
 * inaudible static with zero errors. assertTtsProviderSupportsMediaStreams
 * must fail loud at boot instead.
 */
describe('assertTtsProviderSupportsMediaStreams — P0 boot guard', () => {
  const streamingCapableProvider: TtsProvider = new ElevenLabsTtsProvider('key');
  const nonStreamingProvider: TtsProvider = new OpenAiTtsProvider('key');

  it('throws when media streams is enabled and the resolved provider cannot stream PCM', () => {
    expect(() =>
      assertTtsProviderSupportsMediaStreams({
        mediaStreamsEnabled: true,
        provider: nonStreamingProvider,
        ttsProviderEnv: undefined,
      }),
    ).toThrow(/TWILIO_MEDIA_STREAMS_ENABLED=true/);
    expect(() =>
      assertTtsProviderSupportsMediaStreams({
        mediaStreamsEnabled: true,
        provider: nonStreamingProvider,
        ttsProviderEnv: undefined,
      }),
    ).toThrow(/synthesizeStream/);
  });

  it('does not throw when media streams is disabled, regardless of provider capability', () => {
    expect(() =>
      assertTtsProviderSupportsMediaStreams({
        mediaStreamsEnabled: false,
        provider: nonStreamingProvider,
      }),
    ).not.toThrow();
    expect(() =>
      assertTtsProviderSupportsMediaStreams({
        mediaStreamsEnabled: false,
        provider: undefined,
      }),
    ).not.toThrow();
  });

  it('does not throw when the resolved provider implements synthesizeStream', () => {
    expect(() =>
      assertTtsProviderSupportsMediaStreams({
        mediaStreamsEnabled: true,
        provider: streamingCapableProvider,
        ttsProviderEnv: 'elevenlabs',
      }),
    ).not.toThrow();
  });

  it('does not throw when no provider resolved at all (surfaced separately via /health)', () => {
    expect(() =>
      assertTtsProviderSupportsMediaStreams({
        mediaStreamsEnabled: true,
        provider: undefined,
      }),
    ).not.toThrow();
  });

  it('error message names the misconfigured TTS_PROVIDER value', () => {
    expect(() =>
      assertTtsProviderSupportsMediaStreams({
        mediaStreamsEnabled: true,
        provider: nonStreamingProvider,
        ttsProviderEnv: 'openai',
      }),
    ).toThrow(/TTS_PROVIDER=openai/);
  });
});
