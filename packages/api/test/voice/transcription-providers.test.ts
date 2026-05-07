/**
 * P0-012 — Voice ingestion: OpenAI Whisper transcription provider.
 *
 * Verifies the provider fetches the audio URL, posts to the Whisper API with
 * the expected auth + form body, surfaces the transcript, and throws on
 * upstream failures.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  OpenAiWhisperProvider,
  DevNoopTranscriptionProvider,
  createTranscriptionProvider,
} from '../../src/voice/transcription-providers';

function audioResponse(ok = true, status = 200): Response {
  return new Response(new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }), {
    status,
    statusText: ok ? 'OK' : 'ERR',
  });
}

describe('OpenAiWhisperProvider', () => {
  it('fetches audio then posts to Whisper with bearer auth and form body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(audioResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: 'hello world' }), { status: 200 })
      );
    const provider = new OpenAiWhisperProvider('sk_test', fetchMock);

    const result = await provider.transcribe('https://cdn.example/audio.webm');

    expect(result.transcript).toBe('hello world');
    expect(result.metadata.provider).toBe('openai-whisper');
    expect(result.metadata.model).toBe('whisper-1');
    expect(result.metadata.processedAt).toBeTruthy();

    // First call fetches the audio URL
    expect(fetchMock.mock.calls[0][0]).toBe('https://cdn.example/audio.webm');

    // Second call posts to Whisper with the bearer header
    const [whisperUrl, whisperInit] = fetchMock.mock.calls[1];
    expect(whisperUrl).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(whisperInit.method).toBe('POST');
    expect((whisperInit.headers as Record<string, string>).Authorization).toBe('Bearer sk_test');
    expect(whisperInit.body).toBeInstanceOf(FormData);
  });

  it('throws a descriptive error when the audio URL fails to fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const provider = new OpenAiWhisperProvider('sk_test', fetchMock);

    await expect(provider.transcribe('https://cdn.example/missing.webm')).rejects.toThrow(
      /Failed to fetch audio.*404/
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws with body text when Whisper returns non-OK', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(audioResponse())
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }));
    const provider = new OpenAiWhisperProvider('sk_test', fetchMock);

    await expect(provider.transcribe('https://cdn.example/audio.webm')).rejects.toThrow(
      /Whisper API error 429: rate limited/
    );
  });

  it('returns empty transcript when Whisper body has no text', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(audioResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    const provider = new OpenAiWhisperProvider('sk_test', fetchMock);

    const result = await provider.transcribe('https://cdn.example/audio.webm');
    expect(result.transcript).toBe('');
  });
});

describe('DevNoopTranscriptionProvider', () => {
  it('returns a deterministic dev-mode placeholder', async () => {
    const provider = new DevNoopTranscriptionProvider();
    const result = await provider.transcribe('https://cdn.example/audio.webm');

    expect(result.transcript).toContain('[Dev mode]');
    expect(result.metadata.provider).toBe('dev-fallback');
  });
});

describe('createTranscriptionProvider', () => {
  it('returns OpenAiWhisperProvider when API key is supplied', () => {
    const provider = createTranscriptionProvider('sk_live');
    expect(provider).toBeInstanceOf(OpenAiWhisperProvider);
  });

  it('returns DevNoopTranscriptionProvider when API key is missing', () => {
    expect(createTranscriptionProvider(undefined)).toBeInstanceOf(DevNoopTranscriptionProvider);
    expect(createTranscriptionProvider('')).toBeInstanceOf(DevNoopTranscriptionProvider);
  });
});
