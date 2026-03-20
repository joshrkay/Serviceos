/**
 * Pluggable STT provider interface.
 * Implementations accept raw audio and return a transcript.
 */
export interface STTProvider {
  readonly name: string;
  transcribe(
    audioBuffer: Buffer,
    contentType: string
  ): Promise<{ transcript: string; metadata: Record<string, unknown> }>;
}
