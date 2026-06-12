/**
 * RV-130 — deterministic recording-objection detector.
 *
 * v1 keyword check (run in the adapter's shared safety-scan layer BEFORE any
 * LLM call — same pattern as the emergency/frustration detectors, and
 * deliberately NOT a new intent in the classifier). A match pauses the
 * active call recording via the injected recording-control seam and appends
 * a `{ kind: 'recording', state: 'revoked' }` consent event.
 */

export const RECORDING_OBJECTION_PHRASES: ReadonlyArray<string> = [
  'stop recording',
  'quit recording',
  'stop taping',
  "don't record",
  'do not record',
  'not record this call',
  'stop the recording',
  'turn off the recording',
  "i don't consent to being recorded",
  'i do not consent to being recorded',
];

const OBJECTION_REGEXES = RECORDING_OBJECTION_PHRASES.map((kw) => {
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { keyword: kw, regex: new RegExp(`\\b${escaped}\\b`, 'i') };
});

export interface RecordingObjectionMatch {
  matched: boolean;
  keyword?: string;
}

export function detectRecordingObjection(transcript: string): RecordingObjectionMatch {
  for (const { keyword, regex } of OBJECTION_REGEXES) {
    if (regex.test(transcript)) {
      return { matched: true, keyword };
    }
  }
  return { matched: false };
}

/** Spoken acknowledgment after a recording objection (turn-consuming). */
export const RECORDING_OBJECTION_ACK =
  "Understood — I've paused the recording. How else can I help you?";
