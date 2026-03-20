import { STTProvider } from './types';

/**
 * OpenAI Whisper STT provider.
 * Sends audio to the Whisper API and returns the transcript.
 */
export class WhisperProvider implements STTProvider {
  readonly name = 'openai-whisper';
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async transcribe(
    audioBuffer: Buffer,
    contentType: string
  ): Promise<{ transcript: string; metadata: Record<string, unknown> }> {
    const ext = contentType.includes('webm') ? 'webm'
      : contentType.includes('wav') ? 'wav'
      : contentType.includes('ogg') ? 'ogg'
      : contentType.includes('mpeg') ? 'mp3'
      : 'webm';

    const fd = new FormData();
    fd.append('file', new Blob([audioBuffer], { type: contentType }), `audio.${ext}`);
    fd.append('model', 'whisper-1');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      body: fd,
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Whisper API error ${res.status}: ${errBody}`);
    }

    const data = (await res.json()) as { text?: string };
    return {
      transcript: data.text || '',
      metadata: { provider: this.name, processedAt: new Date().toISOString() },
    };
  }
}

/**
 * Dev fallback STT provider.
 * Returns a placeholder transcript when no API key is configured.
 */
export class DevFallbackProvider implements STTProvider {
  readonly name = 'dev-fallback';

  async transcribe(
    _audioBuffer: Buffer,
    _contentType: string
  ): Promise<{ transcript: string; metadata: Record<string, unknown> }> {
    return {
      transcript: '[Dev mode] Voice transcription placeholder — configure AI_PROVIDER_API_KEY for real STT.',
      metadata: { provider: this.name, processedAt: new Date().toISOString() },
    };
  }
}

/**
 * Create an STT provider based on environment configuration.
 */
export function createSTTProvider(apiKey?: string): STTProvider {
  if (apiKey) {
    return new WhisperProvider(apiKey);
  }
  return new DevFallbackProvider();
}
