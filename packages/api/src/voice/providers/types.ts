export interface STTOptions {
  /** ISO 639-1 language code hint (e.g. 'en', 'es', 'fr'). Improves accuracy. */
  language?: string;
}

/**
 * Pluggable STT provider interface.
 * Implementations accept raw audio and return a transcript.
 */
export interface STTProvider {
  readonly name: string;
  transcribe(
    audioBuffer: Buffer,
    contentType: string,
    options?: STTOptions
  ): Promise<{ transcript: string; metadata: Record<string, unknown> }>;
}
