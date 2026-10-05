/**
 * Builds F1 escalation summary inputs from an in-memory voice session.
 * Pure — no I/O.
 */
import type { VoiceSession } from './voice-session-store';
import type { EscalationContext, TranscriptTurn } from './escalation-summary-builder';
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
}

/**
 * @param escalationReason the FSM's `notify_oncall` reason. The dispatcher-
 *   facing reason itself is derived by the escalate-to-human skill
 *   (`mapSkillReasonToBuilderReason`); here it only decides whether the
 *   caller's self-introduction is a claim worth carrying (#1616).
 */
export function buildCallerContextFromSession(
  session: VoiceSession,
  callerPhone: string,
  escalationReason: string,
): CallerContextBundle {
  const ctx = session.machine.currentContext;
  const transcriptSnapshot = parseTranscriptSnapshot(session.transcript);
  // #1616 — a claims-existing-customer hand-off (#1587) fires on the turn
  // that carried the caller's self-introduction ("Hi, this is Jane Smith"),
  // from a line NO record is bound to. So: identity hand-off, no record on
  // the line, last turn names someone → that name is the caller's CLAIM
  // (never `caller.name`). A caller with a record bound to this line (the
  // archived case) introducing themselves is not claiming another record.
  const noRecordOnLine = !ctx.customerId && !session.customerId;
  const claimedName =
    escalationReason === 'caller_identification_failed' && noRecordOnLine
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
  };
}
