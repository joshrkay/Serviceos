/**
 * Deterministic voice-approval classifier. Given a short transcript
 * of the operator's reply ("yes", "no, cancel", "approve it"),
 * decide whether it is an approval / rejection / retry / unknown.
 *
 * Intentionally NOT backed by an LLM: we want predictable,
 * audit-friendly behavior for a security-sensitive approval gate.
 * Ambiguous replies return 'unknown' and the client falls back to
 * screen-tap UX.
 *
 * NOT for the RV-071 confirm stage — use classifyStrictConfirm; this one
 * accepts embedded approve words.
 */
export type VoiceApprovalDecision = 'approve' | 'cancel' | 'repeat' | 'edit' | 'unknown';

const APPROVE_PATTERNS: RegExp[] = [
  /\bapprove\b/i,
  /\byes\b/i,
  /\byeah\b/i,
  /\byep\b/i,
  /\bconfirm(ed)?\b/i,
  /\bgo ahead\b/i,
  /\bdo it\b/i,
  /\bsend it\b/i,
  /\bokay approve\b/i,
];

const CANCEL_PATTERNS: RegExp[] = [
  /\bcancel\b/i,
  /\bno\b/i,
  /\bnope\b/i,
  /\bstop\b/i,
  /\bdon'?t\b/i,
  /\bnever mind\b/i,
  /\bnevermind\b/i,
  /\breject\b/i,
];

const REPEAT_PATTERNS: RegExp[] = [
  /\brepeat\b/i,
  /\bsay that again\b/i,
  /\bagain\b/i,
];

const EDIT_PATTERNS: RegExp[] = [/\bedit\b/i, /\bchange\b/i, /\bfix\b/i];

export function classifyVoiceApproval(transcript: string): VoiceApprovalDecision {
  const t = transcript.trim();
  if (t.length === 0) return 'unknown';

  // Check cancel BEFORE approve — "no, approve" and "approve, cancel"
  // are both ambiguous but a negation word should dominate for safety.
  if (CANCEL_PATTERNS.some((re) => re.test(t))) return 'cancel';
  if (APPROVE_PATTERNS.some((re) => re.test(t))) return 'approve';
  if (EDIT_PATTERNS.some((re) => re.test(t))) return 'edit';
  if (REPEAT_PATTERNS.some((re) => re.test(t))) return 'repeat';

  return 'unknown';
}

/**
 * Filler words stripped before strict-confirm word-count check.
 * These alone (e.g. "um yes please") must not inflate the word count.
 */
const STRICT_FILLER = /\b(um|uh|please|okay|ok|alright|sure)\b/gi;

/**
 * Strict-confirm classifier for the confirm stage — guards against
 * retargeting attacks like "actually, approve the Acme invoice instead".
 *
 * Returns:
 *   'approve'  — strict short affirmative (≤3 words after filler strip,
 *                matches approve-word set, no other content words)
 *   'reject'   — strict short negation (same rule, cancel-word set)
 *   'reask'    — non-strict, non-empty utterance → prompt to re-confirm
 *   'unknown'  — empty / silence → treat as non-commit (re-ask)
 *
 * Negation still dominates: a cancel word in ANY position returns 'reject'.
 */
export type StrictConfirmDecision = 'approve' | 'reject' | 'reask' | 'unknown';

/** Approve words allowed as the sole content in a strict affirmative. */
const STRICT_APPROVE_WORDS = new Set([
  'approve', 'approved', 'yes', 'yeah', 'yep', 'confirm', 'confirmed',
  'go', 'ahead', 'do', 'it', 'send', 'correct', 'right',
]);

/** Cancel words allowed as the sole content in a strict rejection. */
const STRICT_CANCEL_WORDS = new Set([
  'no', 'nope', 'cancel', 'stop', 'reject', 'rejected',
  'nevermind', 'never', 'mind', 'dont', "don't", 'nah',
]);

export function classifyStrictConfirm(transcript: string): StrictConfirmDecision {
  const t = transcript.trim();
  if (t.length === 0) return 'unknown';

  // Negation always dominates — check before anything else.
  if (CANCEL_PATTERNS.some((re) => re.test(t))) return 'reject';

  // Strip filler words and punctuation, then tokenize.
  const stripped = t
    .replace(STRICT_FILLER, ' ')
    .replace(/[^a-z0-9' ]/gi, ' ')
    .trim();
  const words = stripped.split(/\s+/).filter((w) => w.length > 0);

  // Empty after stripping fillers (e.g. "um please") — treat as unknown.
  if (words.length === 0) return 'unknown';

  // Must be <=3 content words.
  if (words.length > 3) return 'reask';

  // All remaining words must be from the approve set (no other content).
  const allApprove = words.every((w) => STRICT_APPROVE_WORDS.has(w.toLowerCase()));
  if (allApprove) return 'approve';

  // All remaining words in cancel set (negation domination already
  // handled above, but catch standalone reject words here too).
  const allCancel = words.every((w) => STRICT_CANCEL_WORDS.has(w.toLowerCase()));
  if (allCancel) return 'reject';

  // Short but mixed content → re-ask.
  return 'reask';
}
