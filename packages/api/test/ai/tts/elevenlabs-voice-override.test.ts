/**
 * S3-1 (plan U4) — ElevenLabsTtsProvider speaks a per-call voice.
 *
 * `POST /api/voice/tts` resolves the tenant's preset to an ElevenLabs voice
 * id and passes it as `voice`; before S3-1 the provider ignored it and always
 * spoke the constructor's voice. Seam: the provider's public `synthesize` /
 * `voiceForPreset` with fetch stubbed — no real provider calls.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ElevenLabsTtsProvider,
  NoopTtsProvider,
  OpenAiTtsProvider,
} from '../../../src/ai/tts/tts-provider';
import { ElevenLabsStreamConnection } from '../../../src/ai/tts/elevenlabs-stream';

vi.mock('../../../src/ai/tts/elevenlabs-stream', () => ({
  ElevenLabsStreamConnection: vi.fn(function () {
    return {
      synthesize: async function* () {
        yield { pcm: Buffer.alloc(0), isFinal: true };
      },
    };
  }),
}));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.mocked(ElevenLabsStreamConnection).mockClear();
});

function stubFetch() {
  const fn = vi.fn(async () => new Response(Buffer.from('mp3'), { status: 200 }));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

const ADAM = 'pNInz6obpgDQGcFmaJgB';

describe('S3-1 — ElevenLabsTtsProvider per-call voice', () => {
  it('synthesize with `voice` posts to /v1/text-to-speech/<that id>', async () => {
    const fetchFn = stubFetch();
    const provider = new ElevenLabsTtsProvider('sk_test_key', 'constructor-voice');

    const result = await provider.synthesize({ text: 'Tap one to hear it.', voice: ADAM });

    expect(result.provider).toBe('elevenlabs');
    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${ADAM}`);
  });

  it('synthesize without `voice` posts to the constructor voice', async () => {
    const fetchFn = stubFetch();
    const provider = new ElevenLabsTtsProvider('sk_test_key', 'constructor-voice');

    await provider.synthesize({ text: 'Tap one to hear it.' });

    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/constructor-voice');
  });

  it('synthesizeStream is unchanged: it opens the stream on the constructor voice even when `voice` is given', async () => {
    const provider = new ElevenLabsTtsProvider('sk_test_key', 'constructor-voice');

    const chunks = [];
    for await (const chunk of provider.synthesizeStream({ text: 'Hello', voice: ADAM })) chunks.push(chunk);

    expect(chunks).toHaveLength(1);
    expect(vi.mocked(ElevenLabsStreamConnection)).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: 'constructor-voice' }),
    );
  });

  it('maps a preset to its ElevenLabs voice id; providers without a voice catalogue map nothing', () => {
    const preset = { id: 'adam', elevenLabsVoiceId: ADAM };
    expect(new ElevenLabsTtsProvider('sk_test_key').voiceForPreset(preset)).toBe(ADAM);
    expect(new OpenAiTtsProvider('key').voiceForPreset).toBeUndefined();
    expect(new NoopTtsProvider().voiceForPreset).toBeUndefined();
  });
});
