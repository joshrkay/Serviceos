/**
 * Shared causal-ordering helper for the Layer 1 graders.
 *
 * Every `VoiceSessionEvent` is stamped with `ts: Date.now()` at emission
 * (and `proposal_created` carries no `ts` at all), and a whole script can
 * run sub-millisecond — so comparing event order by `ts` ties, and ties
 * mis-grade ordering checks:
 *   - disposition-structured: which turn an `escalation_triggered` belongs
 *     to (a same-ms escalation was mis-attributed to the earlier turn);
 *   - floor #8: whether a `proposal_created` came AFTER the hangup
 *     `session_terminated` (ts-based, this never fired — proposals have no
 *     ts).
 *
 * The append-only log in `observation.events` IS the causal order: the
 * agent classifies before it escalates, and a post-hangup proposal is
 * recorded after the `session_terminated` event that should have stopped
 * it. This returns a lookup from an event to its position in that log — the
 * deterministic ordering key graders use instead of `ts`. Events absent
 * from the log map to -1, sorting before every real event.
 *
 * Identity note: the lookup keys by event-object reference, which is sound
 * because `observation.events` holds the same references graders read and
 * filter (`buildObservation` shallow-copies the bus array, not the events).
 */
import type { VoiceSessionEvent } from '../../agents/customer-calling/voice-session-store';

export function eventLogIndex(
  events: readonly VoiceSessionEvent[],
): (event: VoiceSessionEvent) => number {
  const index = new Map<VoiceSessionEvent, number>();
  events.forEach((e, i) => index.set(e, i));
  return (event) => index.get(event) ?? -1;
}
