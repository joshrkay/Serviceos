/**
 * VoiceSessionStore — minimal placeholder for P8-011.
 *
 * P8-009 owns the canonical `VoiceSessionStore` (under
 * `packages/api/src/ai/agents/customer-calling/voice-session-store.ts`).
 * That story is being implemented in parallel and may not yet exist on
 * the base branch when P8-011 lands.
 *
 * TODO(P8-011 → P8-009 integration): once P8-009 merges and exports
 * a canonical `VoiceSessionStore` interface + InMemory/Pg implementations,
 * delete this file and update `twilio-adapter.ts` to import from there.
 * The shapes intentionally mirror the P8-009 design (sessionId, channel,
 * FSM snapshot, transcript) so the swap is mechanical.
 */

import { CallingAgentStateMachine } from '../ai/agents/customer-calling/state-machine';
import type {
  CallingAgentChannel,
  CallingAgentContext,
  CallingAgentState,
} from '../ai/agents/customer-calling/types';

export interface TranscriptEntry {
  speaker: 'caller' | 'agent';
  text: string;
  ts: number;
}

export interface VoiceSession {
  id: string;
  tenantId: string;
  channel: CallingAgentChannel;
  callSid?: string;
  conversationId?: string;
  machine: CallingAgentStateMachine;
  transcript: TranscriptEntry[];
  createdAt: number;
}

export interface VoiceSessionSnapshot {
  id: string;
  tenantId: string;
  channel: CallingAgentChannel;
  callSid?: string;
  state: CallingAgentState;
  context: Readonly<CallingAgentContext>;
  transcript: TranscriptEntry[];
  createdAt: number;
}

export interface VoiceSessionStore {
  create(
    tenantId: string,
    channel: CallingAgentChannel,
    opts?: { callSid?: string; conversationId?: string }
  ): Promise<VoiceSession>;
  get(sessionId: string): Promise<VoiceSession | null>;
  appendTranscript(sessionId: string, entry: TranscriptEntry): Promise<void>;
  delete(sessionId: string): Promise<void>;
  snapshot(sessionId: string): Promise<VoiceSessionSnapshot | null>;
}

export class InMemoryVoiceSessionStore implements VoiceSessionStore {
  private sessions = new Map<string, VoiceSession>();
  private idCounter = 0;

  async create(
    tenantId: string,
    channel: CallingAgentChannel,
    opts: { callSid?: string; conversationId?: string } = {}
  ): Promise<VoiceSession> {
    const id = `vsess_${Date.now()}_${++this.idCounter}`;
    const machine = new CallingAgentStateMachine({
      sessionId: id,
      tenantId,
      channel,
      callSid: opts.callSid,
      conversationId: opts.conversationId,
    });
    const session: VoiceSession = {
      id,
      tenantId,
      channel,
      callSid: opts.callSid,
      conversationId: opts.conversationId,
      machine,
      transcript: [],
      createdAt: Date.now(),
    };
    this.sessions.set(id, session);
    return session;
  }

  async get(sessionId: string): Promise<VoiceSession | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async appendTranscript(sessionId: string, entry: TranscriptEntry): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.transcript.push(entry);
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async snapshot(sessionId: string): Promise<VoiceSessionSnapshot | null> {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    return {
      id: s.id,
      tenantId: s.tenantId,
      channel: s.channel,
      callSid: s.callSid,
      state: s.machine.currentState,
      context: s.machine.currentContext,
      transcript: [...s.transcript],
      createdAt: s.createdAt,
    };
  }
}
