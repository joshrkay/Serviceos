/**
 * The CANONICAL voice clarification payload.
 *
 * `voice_clarification` is the one proposal type with NO execution handler and
 * no review-completion path — it is an ASK, not a mutation, which is why it
 * sits on the S1 allowlist (`proposals/surface.ts`). That combination makes it
 * the natural landing spot for anything a voice surface cannot turn into a
 * real proposal, and `intentToProposalType` defaults to it
 * (`proposals/voice-intent-map.ts`).
 *
 * Which is exactly where the second-order bug lived: because
 * `voice_clarification` is S1-allowed, a fall-through sailed straight through
 * the surface gate — and then persisted the raw `{intent, entities}` envelope,
 * which `voiceClarificationPayloadSchema` REJECTS (it requires `transcript` +
 * `reason`). The result was a malformed, approve-to-fail card sitting in the
 * operator's queue with no way to act on it.
 *
 * This module owns the shape that cannot happen with. It is deliberately
 * session-free — it takes a `transcript` array rather than a `VoiceSession` —
 * so `proposals/` does not have to import `ai/`.
 *
 * I13: caller-derived data is fine to STORE and display. It just never
 * becomes instructions.
 */
import type { ProposalType } from './proposal';

export interface VoiceClarificationInput {
  /** Session transcript lines, newest last. `caller:`-prefixed lines are the caller's. */
  transcript: readonly string[];
  /** Classifier intent, if there was one. */
  intent: string | undefined;
  /** POST-resolution entities the turn produced. */
  entities: Record<string, unknown>;
  /** The type the caller ASKED for, before coercion — drives `reason`. */
  requestedProposalType: ProposalType;
  sessionId: string;
  /** Telephony only; absent for in-app sessions. */
  callSid?: string;
}

/**
 * Build a contract-valid `voice_clarification` payload for a request that
 * could not become a real proposal.
 *
 * The caller's own words are preserved when we have them, and the structured
 * entities ride along as `requestedEntities` so the operator can see WHICH
 * invoice / time / customer was asked for — otherwise the card says only
 * "caller asked for send_invoice" with nothing actionable on it.
 */
export function buildVoiceClarificationPayload(
  input: VoiceClarificationInput,
): Record<string, unknown> {
  const { transcript: lines, intent, entities, requestedProposalType } = input;
  const lastCallerTurn = [...lines]
    .reverse()
    .find((line) => line.toLowerCase().startsWith('caller:'));
  const entityDetails = Object.entries(entities)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ');
  const transcript =
    (typeof entities.transcript === 'string' && entities.transcript.trim().length > 0
      ? entities.transcript.trim()
      : undefined) ??
    (lastCallerTurn ? lastCallerTurn.slice('caller:'.length).trim() || undefined : undefined) ??
    `Caller asked for '${intent ?? 'unknown'}' but the request was incomplete.` +
      (entityDetails ? ` Details heard: ${entityDetails}.` : '');
  return {
    transcript,
    // An intent that isn't in the shared map lands on the `voice_clarification`
    // DEFAULT — that's an unknown intent. Anything else classified fine but
    // arrived without the fields its contract needs.
    reason: requestedProposalType === 'voice_clarification' ? 'unknown_intent' : 'missing_entities',
    ...(intent ? { suggestedIntents: [intent] } : {}),
    ...(Object.keys(entities).length > 0 ? { requestedEntities: entities } : {}),
    sessionId: input.sessionId,
    ...(input.callSid !== undefined ? { callSid: input.callSid } : {}),
  };
}
