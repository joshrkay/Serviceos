import type { CallOutcome } from './voice-service';

export type VoiceSessionChannel =
  | 'voice_inbound'
  | 'voice_outbound'
  | 'sms'
  | 'mms'
  | 'inapp_voice'
  | 'webchat';

export interface VoiceSessionRow {
  id: string;
  tenantId: string;
  channel: VoiceSessionChannel;
  callSid?: string;
  state: string;
  startedAt: Date;
  endedAt?: Date;
  endedReason?: string;
  outcome?: CallOutcome;
}

export interface CreateVoiceSessionInput {
  id: string;
  tenantId: string;
  channel: VoiceSessionChannel;
  callSid?: string;
  state: string;
}

export interface MarkVoiceSessionEndedInput {
  endedAt: Date;
  endedReason: string;
  outcome: CallOutcome;
  /**
   * Final FSM state at finalize time (`session.machine.currentState`).
   * Persisted alongside outcome so the row reflects the terminal state
   * rather than the initial state captured at session start. Required
   * because `markEnded` upserts — when the create() insert was lost or
   * still in-flight, this is the only state value we have.
   */
  state: string;
  /**
   * Channel + callSid + tenantId from the in-memory session, needed
   * for the upsert path (when the create() row hasn't landed yet, the
   * markEnded upsert has to be able to insert a complete row).
   */
  channel: VoiceSessionChannel;
  callSid?: string;
}

export interface VoiceSessionRepository {
  create(input: CreateVoiceSessionInput): Promise<VoiceSessionRow>;
  /**
   * Upsert: if a row for `id` exists and is still open (`endedAt IS NULL`),
   * stamp it with the terminal outcome; if it doesn't exist (e.g. the
   * fire-and-forget `create()` failed or hasn't committed yet), insert
   * a fully-formed terminal row. Returns the resulting row, or null if
   * the row already had `endedAt` set (idempotent — a duplicate finalize
   * is a no-op).
   */
  markEnded(
    tenantId: string,
    id: string,
    input: MarkVoiceSessionEndedInput,
  ): Promise<VoiceSessionRow | null>;
  findById(tenantId: string, id: string): Promise<VoiceSessionRow | null>;
}

export class InMemoryVoiceSessionRepository implements VoiceSessionRepository {
  private readonly rows = new Map<string, VoiceSessionRow>();

  async create(input: CreateVoiceSessionInput): Promise<VoiceSessionRow> {
    const row: VoiceSessionRow = {
      id: input.id,
      tenantId: input.tenantId,
      channel: input.channel,
      ...(input.callSid !== undefined ? { callSid: input.callSid } : {}),
      state: input.state,
      startedAt: new Date(),
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async markEnded(
    tenantId: string,
    id: string,
    input: MarkVoiceSessionEndedInput,
  ): Promise<VoiceSessionRow | null> {
    const existing = this.rows.get(id);
    if (existing && existing.tenantId !== tenantId) return null;
    if (existing && existing.endedAt) return null;
    const row: VoiceSessionRow = existing ?? {
      id,
      tenantId,
      channel: input.channel,
      ...(input.callSid !== undefined ? { callSid: input.callSid } : {}),
      state: input.state,
      startedAt: new Date(),
    };
    row.state = input.state;
    row.endedAt = input.endedAt;
    row.endedReason = input.endedReason;
    row.outcome = input.outcome;
    this.rows.set(id, row);
    return { ...row };
  }

  async findById(tenantId: string, id: string): Promise<VoiceSessionRow | null> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return null;
    return { ...row };
  }
}
