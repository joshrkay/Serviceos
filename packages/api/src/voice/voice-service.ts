import { randomUUID } from 'crypto';

export type TranscriptionStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface VoiceRecording {
  id: string;
  tenantId: string;
  fileId: string;
  conversationId?: string;
  status: TranscriptionStatus;
  transcript?: string;
  transcriptMetadata?: Record<string, unknown>;
  durationSeconds?: number;
  errorMessage?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IngestVoiceInput {
  tenantId: string;
  fileId: string;
  conversationId?: string;
  createdBy: string;
}

export interface VoiceRepository {
  create(recording: VoiceRecording): Promise<VoiceRecording>;
  findById(tenantId: string, id: string): Promise<VoiceRecording | null>;
  updateStatus(
    tenantId: string,
    id: string,
    status: TranscriptionStatus,
    result?: { transcript?: string; metadata?: Record<string, unknown>; error?: string }
  ): Promise<VoiceRecording | null>;
}

export interface TranscriptionProvider {
  transcribe(audioUrl: string): Promise<{ transcript: string; metadata: Record<string, unknown> }>;
}

const AUDIO_CONTENT_TYPES = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm'];

export function validateVoiceIngest(input: IngestVoiceInput, fileContentType?: string): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.fileId) errors.push('fileId is required');
  if (!input.createdBy) errors.push('createdBy is required');
  if (fileContentType && !AUDIO_CONTENT_TYPES.includes(fileContentType)) {
    errors.push(`Invalid audio content type: ${fileContentType}`);
  }
  return errors;
}

export function createVoiceRecording(input: IngestVoiceInput): VoiceRecording {
  return {
    id: randomUUID(),
    tenantId: input.tenantId,
    fileId: input.fileId,
    conversationId: input.conversationId,
    status: 'pending',
    createdBy: input.createdBy,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Synchronous transcription function type.
 * Accepts raw audio buffer + content type, returns transcript immediately.
 */
export interface TranscribeAudioFn {
  (audioBuffer: Buffer, contentType: string): Promise<{ transcript: string; metadata: Record<string, unknown> }>;
}

/**
 * Create a transcribeAudio function backed by OpenAI Whisper API.
 * Falls back to a dev-mode stub when no API key is provided.
 */
export function createTranscribeAudioFn(apiKey?: string): TranscribeAudioFn {
  if (apiKey) {
    return async (audioBuffer: Buffer, contentType: string) => {
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
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: fd,
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Whisper API error ${res.status}: ${errBody}`);
      }
      const data = (await res.json()) as { text?: string };
      return {
        transcript: data.text || '',
        metadata: { provider: 'openai-whisper', processedAt: new Date().toISOString() },
      };
    };
  }

  return async (_audioBuffer: Buffer, _contentType: string) => ({
    transcript: '[Dev mode] Voice transcription placeholder — configure AI_PROVIDER_API_KEY for real STT.',
    metadata: { provider: 'dev-fallback', processedAt: new Date().toISOString() },
  });
}

export class InMemoryVoiceRepository implements VoiceRepository {
  private recordings: Map<string, VoiceRecording> = new Map();

  async create(recording: VoiceRecording): Promise<VoiceRecording> {
    this.recordings.set(recording.id, { ...recording });
    return recording;
  }

  async findById(tenantId: string, id: string): Promise<VoiceRecording | null> {
    const rec = this.recordings.get(id);
    if (!rec || rec.tenantId !== tenantId) return null;
    return { ...rec };
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: TranscriptionStatus,
    result?: { transcript?: string; metadata?: Record<string, unknown>; error?: string }
  ): Promise<VoiceRecording | null> {
    const rec = this.recordings.get(id);
    if (!rec || rec.tenantId !== tenantId) return null;

    rec.status = status;
    rec.updatedAt = new Date();
    if (result?.transcript) rec.transcript = result.transcript;
    if (result?.metadata) rec.transcriptMetadata = result.metadata;
    if (result?.error) rec.errorMessage = result.error;

    this.recordings.set(id, rec);
    return { ...rec };
  }
}
