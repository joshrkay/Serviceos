/**
 * Builds F1 escalation summary inputs from an in-memory voice session.
 * Pure — no I/O.
 */
import type { VoiceSession } from './voice-session-store';
import type { EscalationContext, IdentityCase, TranscriptTurn } from './escalation-summary-builder';
import { spokenSelfName } from './caller-identity-check';
import { lastCallerLine } from '../../../voice/last-caller-line';

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

function identityCaseFor(escalationReason: string, identityReason?: string): IdentityCase | undefined {
  if (escalationReason !== 'caller_identification_failed') return undefined;
  if (identityReason === 'customer_archived') return 'archived';
  if (identityReason === 'claims_existing_customer') return 'claims';
  return 'unverified';
}

export interface CallerContextBundle {
  caller: EscalationContext['caller'];
  customer?: EscalationContext['customer'];
  intent: EscalationContext['intent'];
  transcriptSnapshot: ReadonlyArray<TranscriptTurn>;
  /** #1630 — set for an identity hand-off; see `EscalationContext.identityCase`. */
  identityCase?: IdentityCase;
}

/**
 * @param escalationReason the FSM's `notify_oncall` reason. The dispatcher-
 *   facing reason itself is derived by the escalate-to-human skill
 *   (`mapSkillReasonToBuilderReason`).
 * @param identityReason the FSM's identity sub-reason (#1630) carried on the
 *   `notify_oncall` payload of a `caller_identification_failed` hand-off. It
 *   alone decides the identity case, and whether the caller's
 *   self-introduction is a claim worth carrying (#1616).
 */
export function buildCallerContextFromSession(
  session: VoiceSession,
  callerPhone: string,
  escalationReason: string,
  identityReason?: string,
): CallerContextBundle {
  const ctx = session.machine.currentContext;
  const transcriptSnapshot = parseTranscriptSnapshot(session.transcript);
  // #1616 / #1630 — the FSM names the identity problem. A claims-existing-
  // customer hand-off (#1587) fires on the turn that carried the caller's
  // self-introduction ("Hi, this is Jane Smith"): that name is the caller's
  // CLAIM (never `caller.name`). An archived record or a failed lookup is not
  // a claim about another record.
  const identityCase = identityCaseFor(escalationReason, identityReason);
  const claimedName =
    identityCase === 'claims' ? spokenSelfName(lastCallerLine(session.transcript) ?? '') : undefined;
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
    ...(identityCase ? { identityCase } : {}),
  };
}
