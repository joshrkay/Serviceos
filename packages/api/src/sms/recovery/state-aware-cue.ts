/**
 * RV-115 — state-aware recovery cue.
 *
 * Composes the PII-safe context fragment for the recovery SMS from the FSM
 * snapshot persisted on the row (`dropped_call_recoveries.context`):
 *
 *   - proposal_created → status cue ("we saved your request…")
 *   - mid_intent       → "about your <intent>" cue, via the curated P8-015
 *                        template table (never the raw slug — same PII rule)
 *   - early / absent   → '' (caller gets the generic apology only)
 *
 * Like extract-context-cue.ts, the output is ONLY curated template text —
 * never transcript-derived strings, names, or addresses.
 */
import { extractContextCue } from '../../voice/recovery/extract-context-cue';
import type { DroppedCallRecoveryContext } from './scheduler';

export const STATE_AWARE_CUE_MAX_CHARS = 120;

export function composeStateAwareCue(
  context: DroppedCallRecoveryContext | null | undefined,
): string {
  if (!context) return '';
  let cue = '';
  switch (context.bucket) {
    case 'proposal_created':
      cue =
        'We saved your request before the call dropped — reply here and ' +
        "we'll confirm the details";
      break;
    case 'mid_intent':
      // Curated intent template (returns '' for unknown slugs — never the
      // raw classifier label).
      cue = extractContextCue(context.intent);
      break;
    case 'early':
    default:
      cue = '';
      break;
  }
  return cue.length > STATE_AWARE_CUE_MAX_CHARS
    ? cue.slice(0, STATE_AWARE_CUE_MAX_CHARS)
    : cue;
}
