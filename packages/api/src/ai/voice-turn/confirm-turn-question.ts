/**
 * #1476 item 3 — a QUESTION asked while the assistant is waiting on a yes/no
 * readback (FSM state `intent_confirm`).
 *
 * Before this module, both confirm branches read any non-"yes" as a
 * correction: the in-app adapter's deterministic matcher, and the phone's
 * `confirm_intent` skill (a question is not a "yes"). So "Can you confirm the
 * number you have for me to call back?" wiped the pending request and spoke
 * "My apologies — let me try again". A question is neither a yes nor a no —
 * it is the caller asking something BEFORE they answer. The honest turn is:
 * answer it, keep the pending request, re-ask the readback.
 *
 * Deterministic on purpose (no classifier prompt change): a confirm turn is a
 * question when it OPENS like one (a WH-word, "can you confirm/tell/repeat…",
 * "do you have…") or when STT punctuated it with "?" and it opens with an
 * auxiliary that is not asking for a CHANGE ("can you make it Tuesday?" is a
 * slot-fill / correction, not a question). Callers run the yes/no matchers
 * first, so "yes?" is still a yes.
 *
 * Shared by both surfaces (`InAppVoiceAdapter.handleInput` and
 * `createVoiceTurnProcessor().speechTurn`) so their answers cannot drift.
 */

import { formatCents } from '../skills/spoken-format';

/** What the confirm-turn question is about, when we can tell deterministically. */
export type ConfirmTurnQuestionKind = 'callback_number' | 'time' | 'price' | 'other';

/**
 * A WH-opener, minus the SUGGESTION shapes ("what about Thursday?", "what if
 * we do Wednesday?", "how about 9?", "why don't we…") — those propose a
 * change, so they stay on the slot-fill / correction path.
 */
const WH_OPENER =
  /^(what|what's|whats|when|where|which|who|who's|whos|whose|why|how)\b(?!\s+(about|if|don't|dont|not)\b)/;
const READBACK_REQUEST_OPENER =
  /^(can|could|would|will) you (please )?(confirm|tell|repeat|read|say|remind|check|give|double check)\b/;
const HAVE_OPENER = /^(do|did) you (have|get|got)\b/;
const AUX_OPENER = /^(is|are|was|were|will|would|does|do|did|can|could)\b/;
/** An auxiliary question that asks for a CHANGE is a correction, not a question. */
const CHANGE_VERB =
  /\b(make|change|move|switch|add|do|book|schedule|put|cancel|push|set|use|instead)\b/;

const CALLBACK_NUMBER =
  /\b(call ?back|callback)\b.*\b(number|phone)\b|\b(number|phone)\b.*\b(call|reach|text|contact|on file|you have|got)\b/;

const TIME_QUESTION = /\b(what time|when|what day|which day|what date)\b/;

const PRICE_QUESTION = /\b(how much|cost|price|charge|total)\b/;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns the kind of question the confirm-turn utterance asks, or null when
 * it is not a question (a yes, a no, a correction, more detail). English
 * phrasing only: a Spanish question does not match and keeps today's
 * behaviour (follow-up: Spanish detection + copy).
 */
export function detectConfirmTurnQuestion(text: string): ConfirmTurnQuestionKind | null {
  const normalized = normalize(text);
  if (!normalized) return null;
  const bare = normalized.replace(/^[^a-z']+/, '');
  const endsWithQuestionMark = /\?\s*$/.test(normalized);
  const isQuestion =
    WH_OPENER.test(bare) ||
    READBACK_REQUEST_OPENER.test(bare) ||
    HAVE_OPENER.test(bare) ||
    (endsWithQuestionMark && AUX_OPENER.test(bare) && !CHANGE_VERB.test(bare));
  if (!isQuestion) return null;
  if (CALLBACK_NUMBER.test(bare)) return 'callback_number';
  if (TIME_QUESTION.test(bare)) return 'time';
  if (PRICE_QUESTION.test(bare)) return 'price';
  return 'other';
}

/** "+14805550199" → "480-555-0199"; anything not NANP-shaped is spoken as given. */
function speakablePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length === 10) {
    return `${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`;
  }
  return phone.trim();
}

function lastFour(phone: string): string | undefined {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : undefined;
}

export interface CallbackNumberInput {
  /**
   * True for the untrusted inbound caller (S1). An S1 caller only ever hears
   * what THEY gave on this call, or their own caller-ID masked — never a
   * number from a customer record (no tenant data disclosure beyond S1).
   */
  untrustedCaller: boolean;
  /** A phone number spoken on THIS call (the pending request's `phone` slot). */
  givenThisCall?: string;
  /** The line the caller is calling from (S1 only; spoken masked). */
  callerId?: string;
  /**
   * Trusted surfaces only: the number on file for the customer the pending
   * request is about. Ignored for an S1 caller.
   */
  onFile?: string;
}

/** The spoken answer to "what number do you have for me to call back?". */
export function answerCallbackNumberQuestion(input: CallbackNumberInput): string {
  if (input.givenThisCall && input.givenThisCall.trim()) {
    return `The callback number I have is ${speakablePhone(input.givenThisCall)}.`;
  }
  if (input.untrustedCaller) {
    const tail = input.callerId ? lastFour(input.callerId) : undefined;
    return tail
      ? `I'd call you back at the number you're calling from, ending in ${tail}.`
      : "I don't have a callback number for you yet.";
  }
  if (input.onFile && input.onFile.trim()) {
    return `The number on file is ${speakablePhone(input.onFile)}.`;
  }
  return "There's no callback number on file for this yet.";
}

function slotText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The answer to a question about the PENDING request's own details, read
 * only from what was captured for it on this call (its slots) — never a
 * record lookup. Undefined when the question is not about such a detail, so
 * the caller can try the read-only lookup path instead.
 */
export function answerPendingDetailQuestion(
  kind: ConfirmTurnQuestionKind,
  entities: Record<string, unknown>,
): string | undefined {
  if (kind === 'time') {
    const when = slotText(entities.newDateTimeDescription) ?? slotText(entities.dateTimeDescription);
    return when ? `I have it down for ${when}.` : "There's no time set on this yet.";
  }
  if (kind === 'price') {
    // `amount` is integer cents on every intent that carries it
    // (intent-classifier.ts ExtractedEntities). No amount → undefined, so
    // the read-only lookup path gets a chance before we say we don't know.
    const cents = entities.amount;
    return typeof cents === 'number' && Number.isInteger(cents) && cents > 0
      ? `I have ${formatCents(cents)} on this.`
      : undefined;
  }
  return undefined;
}
