import { TranscriptionProvider } from './voice-service';

export type FetchLike = typeof fetch;

export interface TranscriptionResult {
  transcript: string;
  metadata: Record<string, unknown>;
}

/**
 * Production transcription provider backed by OpenAI Whisper.
 *
 * Accepts a signed audio URL (typically an R2 presigned GET), streams the
 * bytes into the Whisper API, and returns the transcript + provenance
 * metadata. `fetchImpl` is injectable so tests can exercise the request
 * shape and error handling without a network.
 */
export class OpenAiWhisperProvider implements TranscriptionProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async transcribe(audioUrl: string): Promise<TranscriptionResult> {
    const audioResponse = await this.fetchImpl(audioUrl);
    if (!audioResponse.ok) {
      throw new Error(
        `Failed to fetch audio from ${audioUrl}: ${audioResponse.status}`
      );
    }
    const audioBlob = await audioResponse.blob();

    const fd = new FormData();
    fd.append('file', audioBlob, 'audio.webm');
    fd.append('model', 'whisper-1');

    const res = await this.fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: fd,
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Whisper API error ${res.status}: ${errBody}`);
    }

    const data = (await res.json()) as { text?: string };
    return {
      transcript: data.text ?? '',
      metadata: {
        provider: 'openai-whisper',
        model: 'whisper-1',
        processedAt: new Date().toISOString(),
      },
    };
  }
}

/**
 * Dev/test fallback — used when no AI_PROVIDER_API_KEY is configured so the
 * app can boot and the voice pipeline exercises end-to-end without a network.
 */
export class DevNoopTranscriptionProvider implements TranscriptionProvider {
  async transcribe(audioUrl: string): Promise<TranscriptionResult> {
    return {
      transcript: `[Dev mode] Transcription not available. Audio: ${audioUrl}`,
      metadata: {
        provider: 'dev-fallback',
        processedAt: new Date().toISOString(),
      },
    };
  }
}

export function createTranscriptionProvider(apiKey: string | undefined): TranscriptionProvider {
  if (apiKey) {
    return new OpenAiWhisperProvider(apiKey);
  }
  return new DevNoopTranscriptionProvider();
}
