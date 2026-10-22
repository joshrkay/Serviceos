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
import { FixtureTtsProvider } from '../../../src/ai/tts/fixture-tts-provider';

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
 * S3-6 (plan U4) — the real-stack e2e lane speaks with no vendor key: a
 * bundled silent clip at the vendor boundary, so every route, the clip cache,
 * the per-clip charge and the audit run for real. Never in production.
 */
describe('S3-6 — TTS_PROVIDER=fixture', () => {
  it.each(['dev', 'test', 'development', undefined])('returns the fixture provider when NODE_ENV is %s', (nodeEnv) => {
    const provider = createTtsProvider({ TTS_PROVIDER: 'fixture', NODE_ENV: nodeEnv });
    expect(provider).toBeInstanceOf(FixtureTtsProvider);
  });

  it('refuses to build in production, loudly, even with every vendor key present', () => {
    expect(() =>
      createTtsProvider({
        TTS_PROVIDER: 'fixture',
        NODE_ENV: 'production',
        ELEVENLABS_API_KEY: 'key',
        AI_PROVIDER_API_KEY: 'openai-key',
      }),
    ).toThrow(/TTS_PROVIDER=fixture.*production/);
  });

  it('speaks a short silent audio/mpeg clip for any line, in whichever preset voice is asked', async () => {
    const provider = createTtsProvider({ TTS_PROVIDER: 'fixture', NODE_ENV: 'test' })!;
    const a = await provider.synthesize({ text: 'How should I answer your phone?', voice: 'adam' });
    const b = await provider.synthesize({ text: 'Walsh Plumbing is already set up.' });
    expect(a.contentType).toBe('audio/mpeg');
    expect(a.provider).toBe('fixture-tts');
    // MPEG audio frame sync (11 set bits), Layer III: a real mp3 a browser will decode and play.
    expect(a.audio[0]).toBe(0xff);
    expect(a.audio[1] & 0xe6).toBe(0xe2);
    expect(a.audio.length).toBeGreaterThan(400);
    expect(a.audio.length).toBeLessThan(4096);
    expect(a.durationMs).toBe(200);
    expect(b.audio.equals(a.audio)).toBe(true);
    // Each preset is its own cache voice, as with a real catalogue.
    expect(provider.voiceForPreset?.({ id: 'bella', elevenLabsVoiceId: 'EXAVITQu4vr4xnSDxMaL' })).toBe('fixture:bella');
    // No raw PCM: Media Streams must keep refusing it.
    expect(provider.synthesizeStream).toBeUndefined();
  });

  it('the class itself cannot be constructed in production', () => {
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new FixtureTtsProvider()).toThrow(/production/);
    } finally {
      process.env.NODE_ENV = was;
    }
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
