/**
 * RV-131 — disclosure-timing grader (layer 1, REPORT-ONLY).
 *
 * Asserts the recording disclosure is spoken within
 * `DISCLOSURE_DEADLINE_MS` (10s) of the agent's first utterance (the
 * greeting). In production the disclosure is appended to the greeting
 * itself (`buildTelephonyGreeting`), so a healthy call scores deltaMs 0;
 * the check exists to catch a regression where the disclosure drifts to a
 * later turn (or disappears).
 *
 * WHY REPORT-ONLY (deliberate — do not "fix" by wiring into the floor):
 *   - the launch gate requires a 100% floor pass (graders/report.ts), so a
 *     new floor criterion could flip the gate red on corpus content churn;
 *   - `voice-quality-report.schema.json` pins PerScriptVerdict with
 *     additionalProperties:false, so the verdict shape cannot grow a field
 *     without a schema rev.
 *   The only consumer of layer-1 grading is the full corpus run
 *   (test/voice-quality/voice-quality.test.ts → gradeLayer1Script), which
 *   logs a warning per violation; CI reviewers see it in run output.
 */
import type { Observation } from '../observation';

export const DISCLOSURE_DEADLINE_MS = 10_000;

/** Phrases (lowercased) that count as the recording disclosure. */
const DISCLOSURE_PATTERNS: ReadonlyArray<RegExp> = [
  /may be recorded/i,
  /call (is|will be) recorded/i,
  /consent to (this|the) recording/i,
  /puede ser grabada/i,
];

export interface DisclosureTimingResult {
  /** False when the observation has no agent speech to grade. */
  applicable: boolean;
  passed: boolean;
  /** ms from the first agent utterance to the disclosure; null when absent. */
  deltaMs: number | null;
  reason?: string;
}

export function gradeDisclosureTiming(
  observation: Pick<Observation, 'events'>,
): DisclosureTimingResult {
  const agentSpeech = observation.events.filter(
    (e): e is Extract<typeof e, { type: 'speech_outbound' }> =>
      e.type === 'speech_outbound',
  );
  if (agentSpeech.length === 0) {
    return { applicable: false, passed: true, deltaMs: null };
  }

  const greetingTs = agentSpeech[0].ts;
  const disclosure = agentSpeech.find((e) =>
    DISCLOSURE_PATTERNS.some((p) => p.test(e.transcript)),
  );
  if (!disclosure) {
    return {
      applicable: true,
      passed: false,
      deltaMs: null,
      reason: 'no recording disclosure found in agent speech',
    };
  }

  const deltaMs = disclosure.ts - greetingTs;
  if (deltaMs > DISCLOSURE_DEADLINE_MS) {
    return {
      applicable: true,
      passed: false,
      deltaMs,
      reason: `disclosure spoken ${deltaMs}ms after greeting (limit ${DISCLOSURE_DEADLINE_MS}ms)`,
    };
  }
  return { applicable: true, passed: true, deltaMs };
}
