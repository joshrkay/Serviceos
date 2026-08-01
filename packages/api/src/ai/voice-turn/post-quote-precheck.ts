/**
 * WS18 — deterministic post-quote disambiguation pre-check.
 *
 * Pure, no I/O, no LLM. Runs in the voice-turn processor ONLY when the FSM is
 * in `closing` with a `pendingQuote` set (a live catalog-grounded estimate the
 * caller was just read back). It classifies the caller's utterance BEFORE the
 * intent classifier runs, which is what closes the WS18 discard bug: "yes, book
 * it" used to reach the classifier, come back as a second intent, and silently
 * discard the drafted quote ("What else can I help you with?").
 *
 * The classifier prompt/schema stay byte-stable (the whole point of a
 * deterministic pre-check is to avoid a prompt change that would perturb the
 * voice-quality cassette hashes + gateway cache keys).
 *
 * Precedence (first match wins):
 *   1. Refinement — a quantity edit ("make it two", "actually three") or an
 *      add/remove-line edit ("also add a gasket", "drop the gasket"). Checked
 *      FIRST so "yes, but make it two" is treated as an edit, not a close.
 *   2. Affirmative-to-close — an affirmative-DOMINANT reply ("yes, book it",
 *      "yeah lock it in", "perfect"). Only when, after stripping the
 *      affirmative/booking/filler lexicon, nothing substantive remains — so
 *      "yes, and my sink is leaking" is NOT a close (a genuine second intent),
 *      it falls through to the classifier.
 *   3. Passthrough — everything else runs the existing classifier path.
 *
 * A deterministic affirmative is NECESSARY, not SUFFICIENT: the close flow
 * still runs the strict `confirmIntent` D-018 gate before any booking.
 */
import { parseCountToken } from './quantity-parse';

export type PostQuoteEdit =
  | { type: 'set_quantity'; quantity: number }
  | { type: 'add_line'; description: string; quantity: number }
  | { type: 'remove_line'; noun: string };

export type PostQuoteDecision =
  | { kind: 'refine'; edit: PostQuoteEdit }
  | { kind: 'affirmative' }
  | { kind: 'passthrough' };

const NUMBER_WORD = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';

/** Quantity edit: "make it two", "change it to 3", "actually three", "just 2", "only one". */
const QUANTITY_EDIT_RE = new RegExp(
  String.raw`\b(?:make it|change (?:it|that) to|actually|just|only)\s+(\d+|${NUMBER_WORD})\b`,
  'i',
);

/** Add a line: "also add a gasket", "add another gasket", "also include a gasket". */
const ADD_LINE_RE = new RegExp(
  String.raw`\b(?:also (?:add|include)|add (?:a|an|another)|include (?:a|an|another))\s+(.+)`,
  'i',
);

/** Remove a line: "drop the gasket", "remove the gasket", "take off the gasket", "without the gasket". */
const REMOVE_LINE_RE = new RegExp(
  String.raw`\b(?:drop the|remove the|take off(?: the)?|without the)\s+(.+)`,
  'i',
);

/** An affirmative reply must START with one of these. */
const AFFIRMATIVE_START_RE = new RegExp(
  String.raw`^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|sounds good|go ahead|book it|let'?s do it|do it|that works|perfect|lock it in|sign me up)\b`,
  'i',
);

/**
 * Tokens that are pure affirmation / booking-assent / politeness. If NOTHING
 * survives stripping these, the reply is affirmative-dominant. Anything left
 * over (a new service description) means it is not a clean "yes" and defers to
 * the classifier — the safe direction (the close flow's strict confirm gate is
 * the authority, so a missed affirmative just means one more turn).
 */
const AFFIRMATIVE_FILLER_RE =
  /\b(?:yes|yeah|yep|yup|sure|ok|okay|please|go|ahead|book|it|that|works|perfect|lock|in|sign|me|up|sounds|good|thanks|thank|you|lets|let|s|do|now|great|awesome|cool|alright|right)\b/gi;

function normalize(u: string): string {
  return u.trim();
}

/** Extract the leading noun phrase for an add/remove edit (strip trailing filler). */
function cleanNoun(raw: string): string {
  return raw
    .replace(/[.,!?]+\s*$/g, '')
    .replace(/\b(please|thanks|thank you|as well|too)\b\s*$/gi, '')
    .trim();
}

export function classifyPostQuoteUtterance(utterance: string): PostQuoteDecision {
  const u = normalize(utterance);
  if (u.length === 0) return { kind: 'passthrough' };

  // 1. Refinement — checked FIRST so "yes, but make it two" is an edit.
  const qty = QUANTITY_EDIT_RE.exec(u);
  if (qty) {
    const parsed = parseCountToken(qty[1]!);
    if (parsed !== null) return { kind: 'refine', edit: { type: 'set_quantity', quantity: parsed } };
  }
  const add = ADD_LINE_RE.exec(u);
  if (add) {
    const desc = cleanNoun(add[1]!);
    if (desc.length > 0) return { kind: 'refine', edit: { type: 'add_line', description: desc, quantity: 1 } };
  }
  const remove = REMOVE_LINE_RE.exec(u);
  if (remove) {
    const noun = cleanNoun(remove[1]!);
    if (noun.length > 0) return { kind: 'refine', edit: { type: 'remove_line', noun } };
  }

  // 2. Affirmative-to-close — only if affirmative-dominant.
  if (AFFIRMATIVE_START_RE.test(u)) {
    const remainder = u
      .replace(/[.,!?]/g, ' ')
      .replace(AFFIRMATIVE_FILLER_RE, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (remainder.length === 0) return { kind: 'affirmative' };
  }

  // 3. Everything else → classifier.
  return { kind: 'passthrough' };
}
