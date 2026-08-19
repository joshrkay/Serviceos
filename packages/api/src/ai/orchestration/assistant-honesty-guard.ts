/**
 * HONEST-FAILURE GUARD for the in-app assistant (`POST /api/assistant/chat`).
 *
 * WHY THIS EXISTS
 * ---------------
 * A live diagnostic against Development (main `19de36cb`) produced two
 * replies that are worse than any error. Both reproduced twice. From
 * `ai_runs` (tenant b8e2dc0f-04c2-4ba0-9385-0ebcf3168052), verbatim:
 *
 *   "Put me down for two hours on this one."
 *     classify_intent   completed → {"intentType":"unknown","confidence":0.4}
 *     assistant.general completed → "I've scheduled you for two hours on this job."
 *
 *   "Book her for Thursday at ten."
 *     classify_intent   FAILED → 429 requests-per-day (RPD) 10000/10000
 *     assistant.general completed → "I have scheduled the appointment for Thursday at 10 AM."
 *
 * No proposal exists for either turn. A tradesperson drives away believing
 * the time was logged and the job booked. An error gets retried; a false
 * confirmation gets trusted.
 *
 * NEITHER was a dispatch-map defect. PR #772 wired `log_time_entry` and
 * `create_appointment` into both chat dispatch maps correctly and that wiring
 * is intact. Dispatch was simply never REACHED: once because the classifier
 * returned `unknown` at 0.4 (below CLASSIFIER_CONFIDENCE_THRESHOLD = 0.6),
 * once because the classify call threw into the route's bare `catch { }`.
 * Both then fell to the generic LLM, which has no tools, no database, and —
 * critically — no idea it had done nothing. So it narrated success.
 *
 * THE SHAPE OF THE FIX
 * --------------------
 * A prompt-only fix is a hope: the model can ignore it, and the two observed
 * failures are precisely a model doing as it pleases. This module is
 * structural, in three layers, and protects EVERY unwired intent rather than
 * only the two that happened to be observed:
 *
 *   1. `isActionIntent` + `buildUnmappedCapabilityReply` — a classified WRITE
 *      intent with no handler on this surface short-circuits to a
 *      deterministic refusal and never reaches the LLM at all.
 *   2. `NO_ACTION_TAKEN_DIRECTIVE` — the fallback LLM is told, in its own
 *      system prompt, the one fact it cannot otherwise know: that it has
 *      taken no action and must not imply otherwise.
 *   3. `detectFabricatedActionClaim` — the fallback reply is VERIFIED before
 *      it leaves the route. A first-person completed-action claim in a reply
 *      carrying no proposal is, by construction, false: there is no code path
 *      on which the generic LLM performs a mutation. Layer 3 is what makes
 *      this class of bug non-recurring, because it does not depend on the
 *      model cooperating.
 *
 * THREE FAILURES, THREE EXPERIENCES
 * ---------------------------------
 * Conflating these is part of why the assistant is confusing today:
 *
 *   unmapped_capability  "I can't do that from here"  (known intent, no handler)
 *   not_understood       "I didn't catch that"        (unknown / low confidence)
 *   classifier_error     "something went wrong"       (the intent path threw)
 *
 * PRECEDENT REUSED
 * ----------------
 * The envelope and the never-throws posture are `dispatchAssistantLookup`'s
 * (`lookup-dispatch.ts`, PR #771): typed states in, a visible reply out,
 * never an exception the route's swallowing catch can turn back into a
 * generic LLM answer. `degraded` / `fallbackStage` are set the way that
 * module's failure reply sets them, so an operator-visible failure is also a
 * machine-visible one.
 */
import type { IntentType } from './intent-classifier';
import type { AssistantLookupReply } from './lookup-dispatch';

/**
 * The assistant-chat reply envelope. Deliberately aliased to
 * `AssistantLookupReply` rather than re-declared — every honest-failure path
 * returns the same shape every other path on this route returns, and notably
 * has NO `proposal` field. The absence of a proposal is the whole point.
 */
export type AssistantHonestReply = AssistantLookupReply;

/** Marks a turn answered by this guard rather than by a model. */
export const HONESTY_GUARD_MODEL = 'honesty-guard';

/**
 * Intents that are QUESTIONS, conversational signals, or lifecycle asks this
 * route deliberately does not perform — as opposed to requests to change
 * something. Everything else in the taxonomy mutates state, so a
 * classified-but-unhandled one must refuse rather than improvise.
 *
 * A DENY-list on purpose: a newly added intent defaults to "action", so the
 * failure mode of forgetting to update this file is an over-cautious refusal,
 * never a fabricated confirmation. `lookup_*` matches by prefix, so new
 * read-only skills need no edit here at all.
 *
 * `approve_proposal` / `reject_proposal` / `edit_proposal` are listed
 * deliberately. They are meta-asks about a proposal's lifecycle, not work this
 * route performs, and the useful answer is directions ("you can approve it
 * from the proposals inbox") rather than a flat refusal. Voice already refuses
 * them deterministically upstream (UB-B3); on the text path they keep falling
 * to the LLM — and layer 3 still catches an "I've approved it" if one appears.
 */
const NON_ACTION_INTENTS: ReadonlySet<string> = new Set<string>([
  // Conversational / signalling — never a write on any surface.
  //
  // `complaint` and `negotiation` were listed here and did NOT meet that
  // criterion (#844): on the recorded-memo surface they are handled by
  // ComplaintTaskHandler / NegotiationGuardrailTaskHandler
  // (workers/voice-action-router.ts) and produce real add_note / callback
  // proposals. Listing them made chat skip the deterministic refusal below
  // and answer from the generic LLM, which has no DB access — the "answered
  // from nothing" failure ai/orchestration/lookup-dispatch.ts documents.
  // They now default to "action", so an unmapped one refuses honestly.
  // Whether chat should EXECUTE them is a separate scope decision (#835);
  // refusing is correct either way.
  'language_switch',
  'operator_request',
  'confirm',
  // A failure to classify, not a request. Handled by buildNotUnderstoodReply.
  'unknown',
  // Proposal-lifecycle meta-asks — see the note above.
  'approve_proposal',
  'reject_proposal',
  'edit_proposal',
]);

/**
 * True when this intent represents a request to CREATE or CHANGE something.
 * `unknown` is not an action — it is a failure to classify, which is a
 * different user experience (see `buildNotUnderstoodReply`).
 */
export function isActionIntent(intent: string): boolean {
  if (!intent) return false;
  if (intent.startsWith('lookup_')) return false;
  return !NON_ACTION_INTENTS.has(intent);
}

/** `log_time_entry` → `log time entry`, for copy the operator can read. */
function humanizeIntent(intent: string): string {
  return intent.replace(/_/g, ' ').trim();
}

/**
 * Appended to the generic fallback LLM's system prompt. This is layer 2 — a
 * belt to `detectFabricatedActionClaim`'s braces, not a substitute for it.
 */
export const NO_ACTION_TAKEN_DIRECTIVE = `CRITICAL — YOU HAVE TAKEN NO ACTION.
You are answering on a text-only path with no tools and no database access. Nothing you say creates, schedules, books, logs, sends, bills, or changes anything in this system. No appointment has been booked. No time has been logged. No record has been written.
Never state or imply that you have done something. Do not say "I've scheduled", "I have booked", "I've logged that", "done", or "all set".
If the user asked you to perform an action, say plainly that you have NOT done it, and tell them what to do instead. You may still answer questions, explain, and give operational advice.`;

/**
 * Verbs describing a COMPLETED mutation in this product. Deliberately narrow:
 * only past/perfect first-person claims are treated as fabrications. Future
 * and conditional forms ("I can schedule that", "I'll draft it once you
 * confirm") are legitimate on this path and must keep working, so they are
 * not matched.
 */
const COMPLETED_ACTION_VERBS = [
  'scheduled',
  'booked',
  'logged',
  'recorded',
  'created',
  'drafted',
  'sent',
  'added',
  'updated',
  'cancell?ed',
  'rescheduled',
  'reassigned',
  'assigned',
  'invoiced',
  'billed',
  'issued',
  'submitted',
  'saved',
  'put you down',
  'put them down',
  'set you up',
  'set that up',
  // Vaguer completion claims. These carry no object, so they are the shapes a
  // model reaches for when it has nothing concrete to report — exactly the
  // situation on this path. "I've taken care of that." was emitted for an
  // 'unknown' turn and is every bit as false as "I've scheduled you".
  // Safe against the conditional forms this file must not flag: "I can handle
  // that" and "I'll take care of it" do not match, because the pattern admits
  // only I / I've / I have plus a fixed adverb set before the verb.
  'taken care of',
  'handled',
].join('|');

/**
 * Claim patterns. Each one, in a reply carrying NO proposal, is a statement
 * about work this path provably did not do. All are global so the negation
 * filter below can skip a match and keep scanning.
 */
const FABRICATION_PATTERNS: ReadonlyArray<RegExp> = [
  // "I've scheduled …", "I have booked …", "I just logged …", "I scheduled …"
  new RegExp(
    String.raw`\bI(?:['’]ve|\s+have)?\s+(?:just\s+|already\s+|now\s+|gone\s+ahead\s+and\s+)*(?:${COMPLETED_ACTION_VERBS})\b`,
    'gi',
  ),
  // "That has been scheduled", "your time has been logged", "it's been booked"
  new RegExp(String.raw`\b(?:has|have|had|['’]s|is)\s+been\s+(?:${COMPLETED_ACTION_VERBS})\b`, 'gi'),
  // "You're all set", "you are booked in", "you're scheduled for Thursday"
  /\byou(?:['’]re|\s+are)\s+(?:all\s+set|set\b|booked\b|scheduled\b|down\s+for\b)/gi,
  // "Done — two hours on the Miller job." / "All set for Thursday."
  /^\s*(?:done|all\s+set)\b/gi,
  /\b(?:that['’]s|thats|it['’]s)\s+(?:now\s+)?(?:booked|scheduled|logged|done)\b/gi,
];

/**
 * Words that invert a claim. "Nothing has been scheduled" and "I have not
 * booked anything" are HONEST statements that happen to contain a completed
 * verb — flagging them would replace a good reply with a worse one.
 */
const NEGATION_RE = /\b(?:no|not|nothing|none|never|n['’]t|haven|hasn|isn|won|didn|cannot|can)\b/i;
const NEGATION_WINDOW = 34;

/**
 * Return the offending fragment when `content` claims an action was
 * completed, or `null` when it does not.
 *
 * ONLY meaningful for a reply with no proposal attached — the caller enforces
 * that. A drafted proposal legitimately says "I've drafted…", because it has.
 */
export function detectFabricatedActionClaim(content: string): string | null {
  if (!content) return null;
  for (const pattern of FABRICATION_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const before = content.slice(Math.max(0, match.index - NEGATION_WINDOW), match.index);
      if (!NEGATION_RE.test(before)) return match[0];
      // Zero-length matches would spin; regexes here always consume input,
      // but guard anyway.
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
  }
  return null;
}

/**
 * "I can't do that." A known write intent with no handler wired on this
 * surface. Deterministic, never reaches a model, and states the absence of
 * action explicitly so it cannot be read as a confirmation.
 */
export function buildUnmappedCapabilityReply(intent: IntentType): AssistantHonestReply {
  return {
    taskType: `assistant.unhandled.${intent}`,
    model: HONESTY_GUARD_MODEL,
    usage: { input: 0, output: 0, total: 0 },
    message: {
      role: 'assistant',
      content:
        `I understood that as a "${humanizeIntent(intent)}" request, but I can't do that from here yet — ` +
        "I haven't created, changed, or scheduled anything. " +
        'You can do it directly in the app for now. I can help with invoices, estimates, ' +
        'jobs, appointments, customers, and questions about your day.',
      reasoning:
        `Intent '${intent}' has no handler wired on the assistant-chat surface — refused ` +
        'instead of letting the generic LLM narrate an action it did not take.',
    },
  };
}

/**
 * "I didn't understand." The classifier returned `unknown` or fell below
 * CLASSIFIER_CONFIDENCE_THRESHOLD, AND the fallback reply then claimed an
 * action was completed. This is the "Put me down for two hours on this one."
 * case: `unknown` at confidence 0.4.
 */
export function buildNotUnderstoodReply(confidence?: number): AssistantHonestReply {
  return {
    taskType: 'assistant.not_understood',
    model: HONESTY_GUARD_MODEL,
    usage: { input: 0, output: 0, total: 0 },
    message: {
      role: 'assistant',
      content:
        "I'm not sure what you wanted me to do there, so I haven't done it — " +
        "I haven't scheduled, logged, or changed anything. " +
        "Tell me which job or customer you mean and what you want, and I'll draft it for you to approve.",
      reasoning:
        'Classifier returned unknown / below-threshold confidence' +
        (typeof confidence === 'number' ? ` (${confidence})` : '') +
        ' and the fallback reply claimed a completed action — asked for clarification ' +
        'instead of confirming work that never happened.',
    },
  };
}

/**
 * "Something broke." The intent path threw — a provider 429, a repo failure,
 * anything — and the fallback reply then claimed an action was completed.
 * This is the "Book her for Thursday at ten." case: classify_intent failed on
 * OpenAI requests-per-day and the bare catch dropped it to the LLM.
 *
 * Worded so it never asserts more than we know: a throw AFTER a proposal was
 * persisted is possible, so this says "I couldn't confirm it", not "nothing
 * was written".
 */
export function buildClassifierErrorReply(error: string): AssistantHonestReply {
  return {
    taskType: 'assistant.intent_failed',
    model: HONESTY_GUARD_MODEL,
    usage: { input: 0, output: 0, total: 0 },
    degraded: true,
    fallbackStage: 'intent-path-failed',
    message: {
      role: 'assistant',
      content:
        "Something went wrong on my end, so I couldn't action that — and I can't confirm anything went through. " +
        'Please try again in a moment, and check the job or schedule before relying on it. ' +
        'If it keeps failing, let support know.',
      reasoning: `Assistant intent path threw: ${error}`,
    },
  };
}
