/**
 * The `intent_confirm` answer rules, shared by EVERY voice surface (#1538).
 *
 * Moved verbatim out of `inapp-adapter.ts` so the phone turn engine
 * (`ai/voice-turn/create-voice-turn-processor.ts`, both phone transports)
 * decides a readback answer with the SAME code as in-app instead of a second
 * copy: the deterministic yes/no matchers, and the D01 / Train-7 slot-fill
 * rule — a same-request answer that carries slots merges into the pending
 * request (`intent_details_supplied`) rather than wiping it (`correction`).
 * `inapp-adapter.ts` re-exports the matchers so existing imports still work.
 */
import type { CallingAgentEvent } from './types';
import { resolveDateTime } from '../../scheduling/resolve-datetime';

/**
 * Whole-utterance affirmations recognized when the caller answers the
 * intent_confirm readback ("...Is that right?"). Kept deterministic so the
 * confirm turn needs no LLM round-trip. Anything NOT clearly affirmative is
 * treated as a correction (safe default: re-capture rather than queue the
 * wrong proposal) — mirrors the confirm-intent skill's "ambiguous → no" rule.
 */
const AFFIRMATION_PHRASES = new Set([
  'yes', 'yeah', 'yep', 'yup', 'yea', 'sure', 'correct', 'right', 'ok', 'okay',
  'confirm', 'confirmed', 'go ahead', 'sounds good', 'that works', 'looks good',
  'do it', 'please do', 'affirmative', 'of course', 'absolutely', 'perfect',
  "that's right", 'thats right', 'that is right', 'exactly', 'yes please',
  // R2 (#inapp-50 conf-01) — the shapes a real operator's "yes" actually
  // takes on a live mic. Each of these previously fell through to
  // `correction` (wiping the readback) or, for a creation intent, to a
  // slot-fill classifier round-trip that came back `intent_detail_unclear`.
  'go for it', 'book it', 'do that', "that's correct", 'that is correct',
  'thats correct', 'sounds right', "that's it", 'thats it', 'yes book it',
  'yes please book it', 'yep go ahead', 'yeah go ahead', "yes that's right",
  'yes thats right', 'right go ahead', 'lets do it', "let's do it",
  // es
  'si', 'sí', 'claro', 'correcto', 'de acuerdo', 'está bien', 'esta bien',
  'adelante', 'perfecto', 'así es', 'asi es',
]);

/**
 * R2 — leading hesitation/discourse tokens stripped before matching. They
 * carry no meaning of their own but they are what a spoken "yes" is wrapped
 * in ("uh yeah, go ahead", "okay so, book it"), and matching only the
 * unwrapped form is why noisy affirmations were being read as corrections.
 * `yeah`/`yep`/`si` are deliberately ABSENT: they are affirmations, not
 * fillers, and stripping them would make "yeah cancel it" look affirmative.
 */
const CONFIRM_LEADING_FILLERS: ReadonlySet<string> = new Set([
  'uh', 'uhh', 'um', 'umm', 'ummm', 'er', 'erm', 'hmm', 'hm', 'ah', 'oh',
  'well', 'so', 'like', 'okay', 'ok', 'alright', 'alrighty', 'right',
]);

/** R2 — trailing politeness stripped before matching ("go ahead please"). */
const CONFIRM_TRAILING_POLITENESS: ReadonlySet<string> = new Set([
  'please', 'thanks', 'thank', 'you', 'sir', 'maam', "ma'am", 'gracias',
  'por', 'favor',
]);

/**
 * Shared normalization for the deterministic confirm/negate matchers:
 * lowercase, fold smart quotes, drop punctuation (apostrophes survive so
 * "that's right" still matches), collapse whitespace.
 */
function normalizeConfirmText(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[.,!?;:"()[\]“”…—–¡¿-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strip the wrapper an operator speaks around a bare yes/no. Returns '' when
 * the utterance was ALL wrapper ("um...") — callers treat that as "no match"
 * rather than as an affirmation, so filler can never confirm a mutation.
 */
function stripConfirmWrapper(normalized: string): string {
  const tokens = normalized.split(' ').filter((token) => token.length > 0);
  let start = 0;
  let end = tokens.length;
  while (start < end && CONFIRM_LEADING_FILLERS.has(tokens[start])) start += 1;
  while (end > start && CONFIRM_TRAILING_POLITENESS.has(tokens[end - 1])) end -= 1;
  return tokens.slice(start, end).join(' ');
}

function matchesAffirmation(value: string): boolean {
  if (value.length === 0) return false;
  if (AFFIRMATION_PHRASES.has(value)) return true;
  return AFFIRMATION_LEAD_TOKENS.has(value.split(' ')[0]);
}

/** Leading affirmative tokens ("yes, that's the one" / "sí, adelante"). */
const AFFIRMATION_LEAD_TOKENS = new Set([
  'yes', 'yeah', 'yep', 'yup', 'yea', 'sure', 'correct', 'confirm', 'confirmed',
  'ok', 'okay', 'absolutely', 'affirmative', 'si', 'sí', 'claro', 'correcto',
  'adelante', 'perfecto',
]);

/**
 * True when the caller's readback response is a clear affirmation. Default is
 * FALSE (→ correction) for anything ambiguous, so we never queue a proposal
 * off an unclear "yes".
 */
export function isAffirmation(text: string): boolean {
  const normalized = normalizeConfirmText(text);
  if (!normalized) return false;
  if (matchesAffirmation(normalized)) return true;
  // R2 — retry against the utterance with its spoken wrapper removed. Only
  // ever ADDS matches: an utterance that already matched returned above.
  const core = stripConfirmWrapper(normalized);
  return core !== normalized && matchesAffirmation(core);
}

/**
 * R2 — the STRICT form: the utterance is an affirmation and NOTHING ELSE.
 *
 * `isAffirmation` matches on the leading token, which is right at the
 * `intent_confirm` readback ("yes, that's the one") and catastrophically
 * wrong anywhere else — "yes, book Garcia for Tuesday" is a booking, not a
 * confirmation. The deterministic pre-classifier guard at `intent_capture` /
 * `closing` (where there is nothing pending to confirm) therefore gates on
 * THIS predicate, so a repeated bare "yes" is answered without an LLM call
 * while a request that merely opens with "yes" still reaches the classifier.
 */
/**
 * #1406 D10 — a closing farewell with no request in it: "goodbye", "bye",
 * "that's all", "never mind, that is all for now. Goodbye.", "thanks, bye".
 * Deliberately narrow: an utterance that still asks for something ("bye,
 * and book Garcia Tuesday") is NOT a farewell and reaches the classifier.
 */
const FAREWELL_WORDS = new Set([
  'goodbye', 'bye', 'byebye', 'bye-bye', 'adios', 'adiós', 'ciao', 'later',
  'that', 'thats', "that's", 'is', 'all', 'it', 'for', 'now', 'never', 'mind',
  'nevermind', 'thanks', 'thank', 'you', 'ok', 'okay', 'no', 'nothing', 'else',
  'im', "i'm", 'done', 'good', 'great', 'see', 'ya', 'talk', 'soon', 'have',
  'a', 'nice', 'day', 'gracias', 'eso', 'es', 'todo', 'hasta', 'luego',
]);
const FAREWELL_ANCHORS = /\b(good-?bye|bye(-?bye)?|adi[oó]s|that'?s all|that is all|nothing else|i'?m done|hasta luego|eso es todo)\b/;

export function isFarewell(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[.,!?;:—–-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized || !FAREWELL_ANCHORS.test(normalized)) return false;
  return normalized.split(' ').every((word) => FAREWELL_WORDS.has(word));
}

export function isPlainAffirmation(text: string): boolean {
  const normalized = normalizeConfirmText(text);
  if (!normalized) return false;
  if (AFFIRMATION_PHRASES.has(normalized)) return true;
  const core = stripConfirmWrapper(normalized);
  return core.length > 0 && AFFIRMATION_PHRASES.has(core);
}

/**
 * D01 — explicit rejections of the intent_confirm readback. Only needed
 * because the confirm turn is no longer "affirmation or correction": a
 * non-affirmative answer that carries new SLOTS is now a slot-fill
 * continuation (see `confirmTurnSlotFillEvent`), so the caller needs a
 * deterministic way to say "no, that's not it" and get the pre-D01
 * correction — without paying a classifier round-trip to be told so.
 */
const NEGATION_PHRASES = new Set([
  'no', 'nope', 'nah', 'negative', 'wrong', 'incorrect', 'cancel', 'cancel that',
  "that's wrong", 'thats wrong', 'that is wrong', "that's not right",
  'thats not right', 'that is not right', "that's not it", 'thats not it',
  'not right', 'not correct', 'start over', 'never mind', 'nevermind',
  // R2 (#inapp-50) — symmetric with the noisy-affirmation set: the shapes a
  // spoken "no" actually takes. `uh no` needs no entry — the shared wrapper
  // strip in `isNegation` handles the hesitation prefix.
  "no that's wrong", 'no thats wrong', 'no that is wrong', "no that's not right",
  'not that one', 'not that', 'scratch that', 'wrong one', 'forget it',
  'hold on', 'stop',
  // es
  'no gracias', 'incorrecto', 'no es correcto', 'cancelar', 'olvídalo', 'olvidalo',
]);

/** Leading negative tokens ("no, that's the wrong customer"). */
const NEGATION_LEAD_TOKENS = new Set(['no', 'nope', 'nah', 'negative', 'incorrecto']);

function matchesNegation(value: string): boolean {
  if (value.length === 0) return false;
  if (NEGATION_PHRASES.has(value)) return true;
  return NEGATION_LEAD_TOKENS.has(value.split(' ')[0]);
}

/** True when the caller's readback response is a clear rejection. */
export function isNegation(text: string): boolean {
  const normalized = normalizeConfirmText(text);
  if (!normalized) return false;
  if (matchesNegation(normalized)) return true;
  // R2 — same wrapper strip as `isAffirmation` ("uh no", "well, not that one").
  const core = stripConfirmWrapper(normalized);
  return core !== normalized && matchesNegation(core);
}

/**
 * D01 — the PENDING intents whose `intent_confirm` readback may be answered
 * with MORE DETAIL rather than a yes/no. Deliberately just the creation
 * family: these are the requests a caller builds up across turns ("book a
 * visit" → "Jordan Lee, 480-555-0199, next Tuesday" → "furnace diagnostic at
 * their home"), and they are the family for which "no such record yet" is
 * the NORMAL outcome (see `requiresExistingEntity` / toResolutionEvent).
 * Every other intent keeps the pre-D01 behavior byte-for-byte: anything that
 * is not a clear affirmation is a correction.
 *
 * ('create_booking' is not an `IntentType` — it is a ProposalType only. Kept
 * here for the same reason entity-resolution.ts keeps it in its own sets:
 * vacuous today, correct the day the intent exists.)
 */
export const SLOT_FILL_INTENTS: ReadonlySet<string> = new Set([
  'create_appointment',
  'create_booking',
  'create_job',
  'create_customer',
  'draft_estimate',
]);

/**
 * D01 round 2 — the intents a re-classified CONFIRM TURN may come back as
 * while still describing the request we are confirming. Superset of
 * `SLOT_FILL_INTENTS`, and the fix for the live turn-3 miss: the deployed
 * sweep (session 0d1f2025, tenant a948cc66) carried turns 1 and 2 correctly
 * and then lost the booking on turn 3, "It's for a furnace diagnostic
 * inspection at their home" → `intent_confirm.correction` → intent_capture →
 * the apology reprompt, no proposal.
 *
 * WHY: a bare job-description fragment classifies as `schedule_inspection`.
 * Read its taxonomy block (intent-taxonomy-blocks.ts): it "books a
 * permit/code inspection visit on a job" and extracts customerName /
 * jobReference / jobTitle / dateTimeDescription — the SAME
 * who/when/where/what vocabulary a booking is built from, with the
 * inspection type itself going into `jobTitle`, a field that block
 * documents as "also the short name of the new work being scheduled on
 * create_appointment". A caller answering "what is this visit for?" with
 * "a furnace diagnostic inspection" has not asked for a second proposal.
 *
 * `add_service_location` joins for the same reason ("at their home" is the
 * booking's WHERE), and `confirm_appointment` because "next Tuesday morning
 * works" is the booking's WHEN in agreement clothing.
 *
 * NOT a blanket accept — this is only the first of two gates. The second is
 * `SLOT_DETAIL_ENTITY_KEYS` below: membership here lets an intent be
 * considered, but only entities in that vocabulary are ever merged, so a
 * sibling that arrives carrying nothing a booking can use is still a
 * correction. Deliberately EXCLUDED: reschedule/cancel/reassign (they
 * operate on an appointment that already exists — "reschedule the Miller
 * appointment to Thursday" must not fold its newDateTimeDescription into a
 * different, unsaved booking), add_note, log_permit, log_warranty_claim
 * (each writes its own separate record), and every lookup.
 */
const SLOT_DETAIL_SIBLING_INTENTS: ReadonlySet<string> = new Set([
  ...SLOT_FILL_INTENTS,
  'schedule_inspection',
  'add_service_location',
  'confirm_appointment',
]);

/**
 * D01 round 2 — the classifier entity keys that are genuinely SLOTS of a
 * creation-family request: its WHO, WHEN, WHERE and WHAT. Only these are
 * ever merged into the pending request, so a sibling classification can
 * never smuggle a foreign field (a `paymentMethod`, an `appointmentReference`
 * naming somebody else's appointment) into the booking under review.
 *
 * This is the "scope by entity overlap" half of the two-gate rule — the
 * discipline that keeps the widened `SLOT_DETAIL_SIBLING_INTENTS` above from
 * becoming a blanket accept. Keys are `ExtractedEntities` members
 * (intent-classifier.ts); `customerId` is included because entity resolution
 * folds a resolver-VERIFIED id under that key.
 */
/**
 * Train-7 regression — the two gates below CONTRADICTED each other for
 * exactly the utterance #938 cited when it widened the family.
 *
 * `confirm_appointment` is a `SLOT_DETAIL_SIBLING_INTENTS` member (gate 1
 * admits it) on the stated reasoning that "next Tuesday morning works" is a
 * booking's WHEN in agreement clothing. But its ONLY extraction field is
 * `appointmentReference` (intent-taxonomy-blocks.ts:341 — "Extract
 * appointmentReference", with the example "The customer confirmed Tuesday's
 * visit", the same agreement-plus-a-day shape), and #938 deliberately kept
 * that key OUT of `SLOT_DETAIL_ENTITY_KEYS` so a reschedule could not fold
 * its target into an unsaved booking. Net effect: gate 1 said "same
 * request", gate 2 filtered the only entity away, `newSlots` came back
 * empty, and the turn fell to `correction` — wiping a booking two turns in.
 * Live evidence: session 12ccb578, D01 turn 2 ("Jordan Lee, 480-555-0199,
 * next Tuesday morning works") corrected ~170ms after turn 1's
 * entity_resolved, i.e. off a cached classification, no LLM call.
 * (`classify_intent` is cache-eligible — gateway/factory.ts
 * DEFAULT_DETERMINISTIC_TASK_TYPES — so the model landing on
 * `confirm_appointment` for this phrasing became sticky rather than
 * intermittent.)
 *
 * Resolved by ALIASING rather than by widening the vocabulary: the
 * reference `confirm_appointment` extracts IS the booking's date text, so
 * it lands on `dateTimeDescription`. This cannot leak a reschedule's target
 * in, because gate 1 already excludes every OTHER intent that emits
 * `appointmentReference` (reschedule / cancel / reassign / notify_delay —
 * see the entity-dictionary line for that key). Mirrors the "aliases where
 * the two vocabularies diverge" section proposals/voice-payload.ts already
 * maintains for the same class of mismatch.
 *
 * Keyed BY SOURCE INTENT, not globally, so the safety argument above is
 * enforced by the structure rather than merely asserted: the alias is
 * literally unreachable for any intent other than the one whose taxonomy
 * block makes the reinterpretation correct. Applied only when the pending
 * request does not already carry the target slot, so a real value captured
 * on an earlier turn always wins.
 */
const SLOT_DETAIL_ALIASES: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  ['confirm_appointment', new Map([['appointmentReference', 'dateTimeDescription']])],
]);

/**
 * Train-7 regression — how many consecutive confirm turns may fail the slot
 * gate before we give up and re-capture. Bounds the "ask again instead of
 * wiping the booking" path in `confirmTurnSlotFillEvent`; a productive turn
 * resets it (transitions.ts). Deliberately small: two clarifying re-asks is
 * the most a readback deserves before starting over, and it matches the
 * spirit of `MAX_INTENT_CAPTURE_RETRIES` / `MAX_DISAMBIGUATION_ATTEMPTS`.
 */
export const MAX_CONFIRM_DETAIL_RETRIES = 2;

const SLOT_DETAIL_ENTITY_KEYS: ReadonlySet<string> = new Set([
  // WHO
  'customerName',
  'customerId',
  'displayName',
  'phone',
  'email',
  // WHEN
  'dateTimeDescription',
  'newDateTimeDescription',
  'scheduleDescription',
  // WHERE
  'address',
  'serviceAddress',
  // WHAT
  'jobTitle',
  'jobReference',
  'lineItemDescriptions',
]);

/** The WHEN slots of `SLOT_DETAIL_ENTITY_KEYS`. */
const WHEN_ENTITY_KEYS = ['dateTimeDescription', 'newDateTimeDescription', 'scheduleDescription'] as const;

/** Pending requests whose readback speaks a day/time (intent-readback.ts `scheduleEn`). */
const TIMED_BOOKING_INTENTS: ReadonlySet<string> = new Set(['create_appointment', 'create_booking']);

export interface ConfirmTurnSlotFillInput {
  /** The request being confirmed (`context.currentIntent`). */
  pendingIntent: string | undefined;
  /** The slots already captured for it (`context.extractedEntities`). */
  pendingEntities: Record<string, unknown> | undefined;
  /** Consecutive no-progress confirm turns so far. */
  confirmDetailRetryCount: number | undefined;
  /** The re-classification of this confirm turn. */
  classifiedIntent: string;
  classifiedEntities: Record<string, unknown>;
  /** The caller's words, carried on a `correction`. */
  text: string;
}

/**
 * D01 — decide what a non-yes/no answer to the `intent_confirm` readback
 * MEANS, given the re-classification of that turn.
 *
 * TWO gates, both of which must pass, so a widened intent family can never
 * become a blanket accept:
 *
 *   1. SAME REQUEST — the turn does not name a DIFFERENT actionable
 *      request. Satisfied by `unknown` (the classifier could not name an
 *      intent for a bare detail fragment — "Jordan Lee, 480-555-0199, next
 *      Tuesday morning works" — which is exactly what a slot-only turn
 *      looks like, and covers the low-confidence path too, since
 *      `classifyIntent` maps a below-threshold pick to `unknown` while
 *      KEEPING its extractedEntities); by the same intent we are
 *      confirming; or by a `SLOT_DETAIL_SIBLING_INTENTS` member — while
 *      confirming a booking, "Jordan Lee, 480-555-0199" reads as
 *      `create_customer` and "a furnace diagnostic inspection at their
 *      home" as `schedule_inspection`, and both are describing THIS
 *      booking, not asking for a second proposal.
 *
 *   2. SLOT OVERLAP — after filtering to `SLOT_DETAIL_ENTITY_KEYS` (and
 *      applying `SLOT_DETAIL_ALIASES`), at least one usable value
 *      remains. This is what bounds gate 1: only a creation request's own
 *      who/when/where/what vocabulary is ever merged, so a sibling that
 *      arrives carrying a foreign field cannot smuggle it into the
 *      booking.
 *
 * A clearly different intent (`send_invoice`, `cancel_appointment`, a
 * lookup) fails gate 1 and is still a `correction` — re-capture rather
 * than fold a foreign request's entities into the pending one.
 *
 * WHAT CHANGED IN TRAIN-7: failing gate 2 is no longer a correction.
 * Twice running, a gate-2 miss has destroyed a multi-turn booking —
 * `correction` clears `currentIntent` AND every slot captured so far, so
 * one bad heuristic guess costs the caller everything they have said. The
 * caller is answering OUR readback; the honest response to "I heard you
 * but got nothing new out of that" is to ask again, not to silently throw
 * the booking away. So a same-request turn with no usable slot now emits
 * `intent_details_supplied` with EMPTY entities, which the FSM handles by
 * staying in `intent_confirm` and re-speaking the readback.
 *
 * Still bounded, which is why #938 rejected this: after
 * `MAX_CONFIRM_DETAIL_RETRIES` consecutive no-progress turns we fall back
 * to `correction`, so an unparseable conversation cannot park the caller
 * in `intent_confirm` forever. A productive turn resets the counter
 * (transitions.ts), and an explicit "no" (`isNegation`) still corrects
 * immediately without any of this.
 */
export function confirmTurnSlotFillEvent(input: ConfirmTurnSlotFillInput): CallingAgentEvent {
  const { pendingIntent, text } = input;
  const entities = input.classifiedEntities;
  const usable = (value: unknown): boolean =>
    value !== undefined &&
    value !== null &&
    value !== '' &&
    !(Array.isArray(value) && value.length === 0);

  const aliases = SLOT_DETAIL_ALIASES.get(input.classifiedIntent);
  const newSlots: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entities)) {
    if (!usable(value)) continue;
    // An alias only fires when the classifier did NOT also emit the
    // target key this turn, and when the request has not already captured
    // it on an earlier turn — a real value always beats an aliased one.
    const aliased = aliases?.get(key);
    if (
      aliased !== undefined &&
      !usable(entities[aliased]) &&
      !usable(input.pendingEntities?.[aliased])
    ) {
      newSlots[aliased] = value;
      continue;
    }
    if (SLOT_DETAIL_ENTITY_KEYS.has(key)) newSlots[key] = value;
  }

  // #1331 — a booking still missing its WHEN, answered with a bare day/time
  // ("Tuesday at 2pm."), takes that phrase as the time even when the
  // classifier named no intent and extracted nothing from the fragment (Layer
  // 2 run 36895893912, two-step-booking): otherwise nothing merges and the
  // caller hears the same "with no day or time yet" readback again. The phrase
  // is kept verbatim as `dateTimeDescription`; it is resolved in the tenant
  // zone downstream like any spoken time. The parse here (in UTC) only decides
  // whether the words ARE a day/time.
  const hasWhen = (bag: Record<string, unknown> | undefined): boolean =>
    WHEN_ENTITY_KEYS.some((k) => usable(bag?.[k]));
  // Only for a bare fragment (`unknown`) or the same request — never a
  // sibling, whose entities the slot gate deliberately keeps out (Train-7).
  if (
    TIMED_BOOKING_INTENTS.has(pendingIntent ?? '') &&
    (input.classifiedIntent === 'unknown' || input.classifiedIntent === pendingIntent) &&
    !hasWhen(newSlots) &&
    !hasWhen(input.pendingEntities)
  ) {
    const phrase = text.trim().replace(/[.!?]+$/, '').trim();
    if (phrase.length > 0 && resolveDateTime(phrase, { timezone: 'UTC' }).ok) {
      newSlots.dateTimeDescription = phrase;
    }
  }

  const sameRequest =
    input.classifiedIntent === 'unknown' ||
    input.classifiedIntent === pendingIntent ||
    (SLOT_DETAIL_SIBLING_INTENTS.has(input.classifiedIntent) &&
      SLOT_FILL_INTENTS.has(pendingIntent ?? ''));
  if (!sameRequest) {
    return { type: 'correction', newTranscript: text };
  }
  if (
    Object.keys(newSlots).length === 0 &&
    (input.confirmDetailRetryCount ?? 0) >= MAX_CONFIRM_DETAIL_RETRIES
  ) {
    return { type: 'correction', newTranscript: text };
  }
  return { type: 'intent_details_supplied', entities: newSlots };
}
