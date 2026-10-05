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
import { spokenSelfName } from './caller-identity-check';

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
  // #1616 — an identity hand-off (#1587 claims-existing-customer / archived
  // record; identifyCaller threw) names the identity problem to the
  // dispatcher; it is not "the AI had low confidence".
  if (reason === 'caller_identification_failed') return 'identity_unverified';
  return 'low_confidence_intent';
}

function lastCallerTurn(turns: ReadonlyArray<TranscriptTurn>): string | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'caller') return turns[i].text;
  }
  return undefined;
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
  const transcriptSnapshot = parseTranscriptSnapshot(session.transcript);
  // #1616 — an identity hand-off fires on the turn that carried the caller's
  // self-introduction ("Hi, this is Jane Smith" — #1587's claims-existing-
  // customer check runs on that very utterance), so the name they claimed is
  // their last turn's. It is a claim: it never becomes `caller.name`.
  const claimedName =
    builderReason === 'identity_unverified'
      ? spokenSelfName(lastCallerTurn(transcriptSnapshot) ?? '')
      : undefined;
  return {
    caller: {
      phone: callerPhone,
      ...(ctx.customerName ? { name: ctx.customerName } : {}),
      ...(ctx.customerId ? { customerId: ctx.customerId } : {}),
      ...(claimedName ? { claimedName } : {}),
    },
    intent: {
      type: ctx.currentIntent ?? 'unknown',
      entities: ctx.extractedEntities ?? {},
      confidence: 1,
    },
    transcriptSnapshot,
    builderReason,
    ...(ctx.escalationReason ? { reasonDetail: ctx.escalationReason } : {}),
  };
}
