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
}

export interface VoiceSessionRepository {
  create(input: CreateVoiceSessionInput): Promise<VoiceSessionRow>;
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
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return null;
    if (row.endedAt) return null;
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
