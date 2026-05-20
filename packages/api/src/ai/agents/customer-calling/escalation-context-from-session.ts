/**
 * Builds F1 escalation summary inputs from an in-memory voice session.
 * Pure — no I/O.
 */
import type { VoiceSession } from './voice-session-store';
import type {
  EscalationContext,
  EscalationReason as BuilderReason,
  TranscriptTurn,
} from './escalation-summary-builder';

const TRANSCRIPT_TURN_RE = /^(caller|agent):\s*(.*)$/i;
const MAX_SNAPSHOT_TURNS = 6;

export function parseTranscriptSnapshot(
  transcript: ReadonlyArray<string>,
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (let i = 0; i < transcript.length; i++) {
    const line = transcript[i];
    const m = TRANSCRIPT_TURN_RE.exec(line);
    if (!m) continue;
    const role = m[1].toLowerCase() === 'caller' ? 'caller' : 'ai';
    turns.push({ role, text: m[2], ts: i });
  }
  return turns.slice(-MAX_SNAPSHOT_TURNS);
}

/** Map notify_oncall / FSM escalation reason strings to builder vocabulary. */
export function mapNotifyReasonToBuilderReason(
  reason: string,
): BuilderReason {
  if (reason === 'operator_request') return 'operator_request';
  if (reason === 'emergency_dispatch') return 'emergency_dispatch';
  if (reason === 'keyword_frustration' || reason.includes('frustration')) {
    return 'keyword_frustration';
  }
  if (reason === 'llm_sentiment') return 'llm_sentiment';
  return 'low_confidence_intent';
}

export interface CallerContextBundle {
  caller: EscalationContext['caller'];
  customer?: EscalationContext['customer'];
  intent: EscalationContext['intent'];
  transcriptSnapshot: ReadonlyArray<TranscriptTurn>;
  builderReason: BuilderReason;
  reasonDetail?: string;
}

export function buildCallerContextFromSession(
  session: VoiceSession,
  callerPhone: string,
  escalationReason: string,
): CallerContextBundle {
  const ctx = session.machine.currentContext;
  const builderReason = mapNotifyReasonToBuilderReason(escalationReason);
  return {
    caller: {
      phone: callerPhone,
      ...(ctx.customerName ? { name: ctx.customerName } : {}),
      ...(ctx.customerId ? { customerId: ctx.customerId } : {}),
    },
    intent: {
      type: ctx.currentIntent ?? 'unknown',
      entities: ctx.extractedEntities ?? {},
      confidence: 1,
    },
    transcriptSnapshot: parseTranscriptSnapshot(session.transcript),
    builderReason,
    ...(ctx.escalationReason ? { reasonDetail: ctx.escalationReason } : {}),
  };
}
