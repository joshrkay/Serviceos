/**
 * LCR-01 — the buffered ElevenLabs synth can return raw PCM.
 *
 * The media-streams adapter recovers a failed TTS stream with a buffered
 * `synthesize()`, and its media path plays only raw PCM16 @ 16 kHz. Before
 * this fix the REST call always asked for mp3, so the recovery was always
 * thrown away. Seam: the public `ElevenLabsTtsProvider.synthesize` (global
 * fetch stubbed).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElevenLabsTtsProvider } from '../../../src/ai/tts/tts-provider';

function okFetch(bytes: number[]) {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(new Uint8Array(bytes), { status: 200 }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('LCR-01 — ElevenLabsTtsProvider.synthesize output format', () => {
  it("outputFormat 'pcm_16000' requests output_format=pcm_16000 and returns audio/pcm", async () => {
    const fetchMock = okFetch([1, 0, 2, 0]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await new ElevenLabsTtsProvider('el-test', 'voice-1').synthesize({
      text: 'Booked for Tuesday.',
      outputFormat: 'pcm_16000',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice-1?output_format=pcm_16000');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Accept).toBeUndefined();
    expect(result.contentType).toBe('audio/pcm');
    expect([...result.audio]).toEqual([1, 0, 2, 0]);
  });

  it('without outputFormat keeps the mp3 default for every other caller', async () => {
    const fetchMock = okFetch([0xff, 0xfb]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await new ElevenLabsTtsProvider('el-test', 'voice-1').synthesize({
      text: 'Booked for Tuesday.',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice-1');
    expect((init?.headers as Record<string, string>).Accept).toBe('audio/mpeg');
    expect(result.contentType).toBe('audio/mpeg');
  });
});
