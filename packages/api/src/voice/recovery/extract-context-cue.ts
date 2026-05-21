/**
 * P8-015 — Partial-transcript context cue (PII-safe).
 *
 * Review-prompt requirement: "partial transcript context is sanitized (no PII
 * leak in the SMS body)." The cue is therefore NEVER built from free-form
 * transcript text. Instead it is a fixed template seeded by the single top
 * intent slug the FSM captured before the drop (e.g. `ac_repair` →
 * "Sounds like you were calling about your AC"). An unknown / absent intent
 * yields no cue at all, and the caller then gets the generic apology only.
 *
 * Mapping unknown slugs to "" (rather than echoing the slug) guarantees we can
 * never surface a raw classifier label, a phone number, an address, or any
 * other transcript-derived string in the outbound SMS.
 */

/** Hard cap on the cue fragment (the full SMS budget is enforced separately). */
export const CONTEXT_CUE_MAX_CHARS = 80;

/**
 * Fixed, human-curated phrasings keyed by intent slug. Only slugs present here
 * produce a cue; anything else falls through to the generic message. Keys are
 * matched case-insensitively and tolerant of separator style (`-`/`_`/space).
 */
const CUE_TEMPLATES: Record<string, string> = {
  ac_repair: 'Sounds like you were calling about your AC',
  hvac: 'Sounds like you were calling about your heating or cooling',
  heating: 'Sounds like you were calling about your heat',
  cooling: 'Sounds like you were calling about your AC',
  plumbing: 'Sounds like you were calling about a plumbing issue',
  leak: 'Sounds like you were calling about a leak',
  electrical: 'Sounds like you were calling about an electrical issue',
  booking: 'Sounds like you were calling to book an appointment',
  schedule_appointment: 'Sounds like you were calling to book an appointment',
  reschedule: 'Sounds like you were calling to change an appointment',
  cancel: 'Sounds like you were calling about an appointment',
  estimate: 'Sounds like you were calling about an estimate',
  quote: 'Sounds like you were calling about a quote',
  invoice: 'Sounds like you were calling about a bill',
  billing: 'Sounds like you were calling about a bill',
  emergency: 'Sounds like you had an urgent issue',
};

/**
 * Normalize an intent slug to the lookup key form: lowercase, with `-`/spaces
 * collapsed to `_`. Returns "" for empty/whitespace input.
 */
function normalizeIntent(intent: string | undefined | null): string {
  if (!intent) return '';
  return intent
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

/**
 * Build the PII-safe context cue for a dropped call. Returns an empty string
 * when there is no usable top intent — callers MUST treat "" as "no cue, use
 * the generic apology only."
 *
 * The returned string is guaranteed to:
 *   - contain only curated template text (never transcript-derived content),
 *   - be at most CONTEXT_CUE_MAX_CHARS characters.
 */
export function extractContextCue(topIntent: string | undefined | null): string {
  const key = normalizeIntent(topIntent);
  if (!key) return '';
  const cue = CUE_TEMPLATES[key];
  if (!cue) return '';
  return cue.length > CONTEXT_CUE_MAX_CHARS
    ? cue.slice(0, CONTEXT_CUE_MAX_CHARS)
    : cue;
}
