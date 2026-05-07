import { randomUUID } from 'crypto';

export type VoiceAttemptStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type VoiceTranscriptSource = 'stt' | 'user_edit' | 'normalize';
export type VoiceCommandStatus =
  | 'pending'
  | 'queued'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface VoiceTranscriptionAttempt {
  id: string;
  tenantId: string;
  recordingId: string;
  attemptNo: number;
  provider: string;
  model?: string;
  status: VoiceAttemptStatus;
  startedAt: Date;
  completedAt?: Date;
  latencyMs?: number;
  errorCode?: string;
  errorMessage?: string;
  rawResponse?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface VoiceTranscriptVersion {
  id: string;
  tenantId: string;
  recordingId: string;
  transcriptionAttemptId?: string;
  versionNo: number;
  text: string;
  source: VoiceTranscriptSource;
  confidence?: number;
  languageCode?: string;
  wordTimestamps: unknown[];
  editorUserId?: string;
  createdAt: Date;
}

export interface VoiceIntentRun {
  id: string;
  tenantId: string;
  recordingId: string;
  transcriptVersionId: string;
  aiRunId?: string;
  intentType: string;
  intentConfidence?: number;
  extractedEntities: Record<string, unknown>;
  rawOutput: Record<string, unknown>;
  createdAt: Date;
}

export interface VoiceCommandRun {
  id: string;
  tenantId: string;
  recordingId: string;
  transcriptVersionId?: string;
  intentRunId?: string;
  conversationId?: string;
  commandType: string;
  commandPayload: Record<string, unknown>;
  targetEntityType?: string;
  targetEntityId?: string;
  idempotencyKey: string;
  currentStatus: VoiceCommandStatus;
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface VoiceCommandEvent {
  id: string;
  tenantId: string;
  commandRunId: string;
  eventType: string;
  fromStatus?: string;
  toStatus?: string;
  actorId?: string;
  actorRole?: string;
  correlationId?: string;
  metadata: Record<string, unknown>;
  occurredAt: Date;
}

export interface VoiceFeedbackLabel {
  id: string;
  tenantId: string;
  recordingId: string;
  transcriptVersionId?: string;
  intentRunId?: string;
  commandRunId?: string;
  feedbackType: string;
  correctedTranscript?: string;
  correctIntent?: string;
  correctPayload: Record<string, unknown>;
  notes?: string;
  labeledBy: string;
  createdAt: Date;
}

export interface TenantVoiceLexiconEntry {
  id: string;
  tenantId: string;
  phrase: string;
  canonicalForm: string;
  pronunciationHint?: string;
  weight: number;
  isActive: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTranscriptionAttemptInput {
  tenantId: string;
  recordingId: string;
  attemptNo: number;
  provider: string;
  model?: string;
}

export interface CompleteTranscriptionAttemptInput {
  tenantId: string;
  attemptId: string;
  latencyMs?: number;
  rawResponse?: Record<string, unknown>;
}

export interface FailTranscriptionAttemptInput {
  tenantId: string;
  attemptId: string;
  errorCode?: string;
  errorMessage: string;
  rawResponse?: Record<string, unknown>;
}

export interface CreateTranscriptVersionInput {
  tenantId: string;
  recordingId: string;
  transcriptionAttemptId?: string;
  versionNo?: number;
  text: string;
  source: VoiceTranscriptSource;
  confidence?: number;
  languageCode?: string;
  wordTimestamps?: unknown[];
  editorUserId?: string;
}

export interface CreateIntentRunInput {
  tenantId: string;
  recordingId: string;
  transcriptVersionId: string;
  aiRunId?: string;
  intentType: string;
  intentConfidence?: number;
  extractedEntities?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
}

export interface UpsertVoiceCommandRunInput {
  tenantId: string;
  recordingId: string;
  transcriptVersionId?: string;
  intentRunId?: string;
  conversationId?: string;
  commandType: string;
  commandPayload?: Record<string, unknown>;
  targetEntityType?: string;
  targetEntityId?: string;
  idempotencyKey: string;
  status: VoiceCommandStatus;
  failureReason?: string;
}

export interface UpdateVoiceCommandStatusInput {
  tenantId: string;
  commandRunId: string;
  status: VoiceCommandStatus;
  failureReason?: string;
}

export interface AppendVoiceCommandEventInput {
  tenantId: string;
  commandRunId: string;
  eventType: string;
  fromStatus?: string;
  toStatus?: string;
  actorId?: string;
  actorRole?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateVoiceFeedbackLabelInput {
  tenantId: string;
  recordingId: string;
  transcriptVersionId?: string;
  intentRunId?: string;
  commandRunId?: string;
  feedbackType: string;
  correctedTranscript?: string;
  correctIntent?: string;
  correctPayload?: Record<string, unknown>;
  notes?: string;
  labeledBy: string;
}

export interface UpsertTenantVoiceLexiconEntryInput {
  tenantId: string;
  phrase: string;
  canonicalForm: string;
  pronunciationHint?: string;
  weight?: number;
  isActive?: boolean;
  createdBy: string;
}

export interface VoiceAuditRepository {
  createTranscriptionAttempt(input: CreateTranscriptionAttemptInput): Promise<VoiceTranscriptionAttempt>;
  completeTranscriptionAttempt(
    input: CompleteTranscriptionAttemptInput
  ): Promise<VoiceTranscriptionAttempt | null>;
  failTranscriptionAttempt(input: FailTranscriptionAttemptInput): Promise<VoiceTranscriptionAttempt | null>;

  createTranscriptVersion(input: CreateTranscriptVersionInput): Promise<VoiceTranscriptVersion>;
  createIntentRun(input: CreateIntentRunInput): Promise<VoiceIntentRun>;

  findCommandRunByIdempotency(tenantId: string, idempotencyKey: string): Promise<VoiceCommandRun | null>;
  upsertCommandRunForRecording(input: UpsertVoiceCommandRunInput): Promise<VoiceCommandRun>;
  updateCommandRunStatus(input: UpdateVoiceCommandStatusInput): Promise<VoiceCommandRun | null>;
  appendCommandEvent(input: AppendVoiceCommandEventInput): Promise<VoiceCommandEvent>;

  createFeedbackLabel(input: CreateVoiceFeedbackLabelInput): Promise<VoiceFeedbackLabel>;
  upsertTenantLexiconEntry(
    input: UpsertTenantVoiceLexiconEntryInput
  ): Promise<TenantVoiceLexiconEntry>;
  listActiveTenantLexicon(tenantId: string): Promise<TenantVoiceLexiconEntry[]>;
}

export function voiceCommandIdempotencyKey(recordingId: string): string {
  return `voice:${recordingId}`;
}

export class InMemoryVoiceAuditRepository implements VoiceAuditRepository {
  private attempts = new Map<string, VoiceTranscriptionAttempt>();
  private transcriptVersions = new Map<string, VoiceTranscriptVersion>();
  private intentRuns = new Map<string, VoiceIntentRun>();
  private commandRuns = new Map<string, VoiceCommandRun>();
  private commandEvents = new Map<string, VoiceCommandEvent>();
  private feedbackLabels = new Map<string, VoiceFeedbackLabel>();
  private lexiconEntries = new Map<string, TenantVoiceLexiconEntry>();

  async createTranscriptionAttempt(input: CreateTranscriptionAttemptInput): Promise<VoiceTranscriptionAttempt> {
    const now = new Date();
    const attempt: VoiceTranscriptionAttempt = {
      id: randomUUID(),
      tenantId: input.tenantId,
      recordingId: input.recordingId,
      attemptNo: input.attemptNo,
      provider: input.provider,
      model: input.model,
      status: 'processing',
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.attempts.set(attempt.id, attempt);
    return { ...attempt };
  }

  async completeTranscriptionAttempt(
    input: CompleteTranscriptionAttemptInput
  ): Promise<VoiceTranscriptionAttempt | null> {
    const existing = this.attempts.get(input.attemptId);
    if (!existing || existing.tenantId !== input.tenantId) return null;
    const updated: VoiceTranscriptionAttempt = {
      ...existing,
      status: 'completed',
      completedAt: new Date(),
      latencyMs: input.latencyMs,
      rawResponse: input.rawResponse,
      updatedAt: new Date(),
    };
    this.attempts.set(updated.id, updated);
    return { ...updated };
  }

  async failTranscriptionAttempt(
    input: FailTranscriptionAttemptInput
  ): Promise<VoiceTranscriptionAttempt | null> {
    const existing = this.attempts.get(input.attemptId);
    if (!existing || existing.tenantId !== input.tenantId) return null;
    const updated: VoiceTranscriptionAttempt = {
      ...existing,
      status: 'failed',
      completedAt: new Date(),
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      rawResponse: input.rawResponse,
      updatedAt: new Date(),
    };
    this.attempts.set(updated.id, updated);
    return { ...updated };
  }

  async createTranscriptVersion(input: CreateTranscriptVersionInput): Promise<VoiceTranscriptVersion> {
    const versions = Array.from(this.transcriptVersions.values()).filter(
      (version) => version.tenantId === input.tenantId && version.recordingId === input.recordingId
    );
    const versionNo =
      input.versionNo ??
      (versions.length > 0 ? Math.max(...versions.map((version) => version.versionNo)) + 1 : 1);
    const transcriptVersion: VoiceTranscriptVersion = {
      id: randomUUID(),
      tenantId: input.tenantId,
      recordingId: input.recordingId,
      transcriptionAttemptId: input.transcriptionAttemptId,
      versionNo,
      text: input.text,
      source: input.source,
      confidence: input.confidence,
      languageCode: input.languageCode,
      wordTimestamps: input.wordTimestamps ?? [],
      editorUserId: input.editorUserId,
      createdAt: new Date(),
    };
    this.transcriptVersions.set(transcriptVersion.id, transcriptVersion);
    return { ...transcriptVersion };
  }

  async createIntentRun(input: CreateIntentRunInput): Promise<VoiceIntentRun> {
    const intentRun: VoiceIntentRun = {
      id: randomUUID(),
      tenantId: input.tenantId,
      recordingId: input.recordingId,
      transcriptVersionId: input.transcriptVersionId,
      aiRunId: input.aiRunId,
      intentType: input.intentType,
      intentConfidence: input.intentConfidence,
      extractedEntities: input.extractedEntities ?? {},
      rawOutput: input.rawOutput ?? {},
      createdAt: new Date(),
    };
    this.intentRuns.set(intentRun.id, intentRun);
    return { ...intentRun };
  }

  async findCommandRunByIdempotency(
    tenantId: string,
    idempotencyKey: string
  ): Promise<VoiceCommandRun | null> {
    const found = Array.from(this.commandRuns.values()).find(
      (run) => run.tenantId === tenantId && run.idempotencyKey === idempotencyKey
    );
    return found ? { ...found } : null;
  }

  async upsertCommandRunForRecording(input: UpsertVoiceCommandRunInput): Promise<VoiceCommandRun> {
    const existing = await this.findCommandRunByIdempotency(input.tenantId, input.idempotencyKey);
    if (!existing) {
      const now = new Date();
      const created: VoiceCommandRun = {
        id: randomUUID(),
        tenantId: input.tenantId,
        recordingId: input.recordingId,
        transcriptVersionId: input.transcriptVersionId,
        intentRunId: input.intentRunId,
        conversationId: input.conversationId,
        commandType: input.commandType,
        commandPayload: input.commandPayload ?? {},
        targetEntityType: input.targetEntityType,
        targetEntityId: input.targetEntityId,
        idempotencyKey: input.idempotencyKey,
        currentStatus: input.status,
        failureReason: input.failureReason,
        createdAt: now,
        updatedAt: now,
      };
      this.commandRuns.set(created.id, created);
      return { ...created };
    }

    const updated: VoiceCommandRun = {
      ...existing,
      recordingId: input.recordingId,
      transcriptVersionId: input.transcriptVersionId ?? existing.transcriptVersionId,
      intentRunId: input.intentRunId ?? existing.intentRunId,
      conversationId: input.conversationId ?? existing.conversationId,
      commandType: input.commandType,
      commandPayload: input.commandPayload ?? existing.commandPayload,
      targetEntityType: input.targetEntityType ?? existing.targetEntityType,
      targetEntityId: input.targetEntityId ?? existing.targetEntityId,
      currentStatus: input.status,
      failureReason: input.failureReason,
      updatedAt: new Date(),
    };
    this.commandRuns.set(updated.id, updated);
    return { ...updated };
  }

  async updateCommandRunStatus(input: UpdateVoiceCommandStatusInput): Promise<VoiceCommandRun | null> {
    const existing = this.commandRuns.get(input.commandRunId);
    if (!existing || existing.tenantId !== input.tenantId) return null;
    const updated: VoiceCommandRun = {
      ...existing,
      currentStatus: input.status,
      failureReason: input.failureReason ?? existing.failureReason,
      updatedAt: new Date(),
    };
    this.commandRuns.set(updated.id, updated);
    return { ...updated };
  }

  async appendCommandEvent(input: AppendVoiceCommandEventInput): Promise<VoiceCommandEvent> {
    const event: VoiceCommandEvent = {
      id: randomUUID(),
      tenantId: input.tenantId,
      commandRunId: input.commandRunId,
      eventType: input.eventType,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      actorId: input.actorId,
      actorRole: input.actorRole,
      correlationId: input.correlationId,
      metadata: input.metadata ?? {},
      occurredAt: new Date(),
    };
    this.commandEvents.set(event.id, event);
    return { ...event };
  }

  async createFeedbackLabel(input: CreateVoiceFeedbackLabelInput): Promise<VoiceFeedbackLabel> {
    const feedbackLabel: VoiceFeedbackLabel = {
      id: randomUUID(),
      tenantId: input.tenantId,
      recordingId: input.recordingId,
      transcriptVersionId: input.transcriptVersionId,
      intentRunId: input.intentRunId,
      commandRunId: input.commandRunId,
      feedbackType: input.feedbackType,
      correctedTranscript: input.correctedTranscript,
      correctIntent: input.correctIntent,
      correctPayload: input.correctPayload ?? {},
      notes: input.notes,
      labeledBy: input.labeledBy,
      createdAt: new Date(),
    };
    this.feedbackLabels.set(feedbackLabel.id, feedbackLabel);
    return { ...feedbackLabel };
  }

  async upsertTenantLexiconEntry(
    input: UpsertTenantVoiceLexiconEntryInput
  ): Promise<TenantVoiceLexiconEntry> {
    const existing = Array.from(this.lexiconEntries.values()).find(
      (entry) => entry.tenantId === input.tenantId && entry.phrase === input.phrase
    );
    if (!existing) {
      const now = new Date();
      const entry: TenantVoiceLexiconEntry = {
        id: randomUUID(),
        tenantId: input.tenantId,
        phrase: input.phrase,
        canonicalForm: input.canonicalForm,
        pronunciationHint: input.pronunciationHint,
        weight: input.weight ?? 1,
        isActive: input.isActive ?? true,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      };
      this.lexiconEntries.set(entry.id, entry);
      return { ...entry };
    }

    const updated: TenantVoiceLexiconEntry = {
      ...existing,
      canonicalForm: input.canonicalForm,
      pronunciationHint: input.pronunciationHint,
      weight: input.weight ?? existing.weight,
      isActive: input.isActive ?? existing.isActive,
      updatedAt: new Date(),
    };
    this.lexiconEntries.set(updated.id, updated);
    return { ...updated };
  }

  async listActiveTenantLexicon(tenantId: string): Promise<TenantVoiceLexiconEntry[]> {
    return Array.from(this.lexiconEntries.values())
      .filter((entry) => entry.tenantId === tenantId && entry.isActive)
      .sort((a, b) => b.weight - a.weight)
      .map((entry) => ({ ...entry }));
  }
}
