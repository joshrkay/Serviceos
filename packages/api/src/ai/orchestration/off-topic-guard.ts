/**
 * Off-topic scope guard (owner-approved 2026-09-30, shipped with #1480).
 *
 * The chat assistant is the operator's back office, not a general chatbot.
 * A turn that classified as nothing (`unknown`) used to fall through to the
 * generic model, which happily wrote poems and answered pub trivia on the
 * tenant's AI budget. This guard declines those — deterministically, after
 * classification, with no prompt change — with one short line that points
 * back at what the assistant does.
 *
 * Bias: ANSWER. A turn is declined only when it matches an explicit
 * non-business pattern; anything else, including every ambiguous ask, still
 * reaches the generic model.
 */

/** Creative writing with no business purpose. */
const CREATIVE_REQUEST_RE = /\b(?:(?:poem|haiku|limerick|sonnet|joke|riddle)s?|song\s+lyrics|bedtime\s+stor(?:y|ies))\b/i;

/**
 * Any of these and the ask is about the business, whatever else it says ("a
 * poem for the customer thank-you card"). Deliberately broad: a false match
 * here only means the model answers, which is the safe direction.
 */
const BUSINESS_TERM_RE =
  /\b(?:customers?|clients?|jobs?|invoices?|estimates?|quotes?|bids?|appointments?|schedul\w*|book(?:ing|ed)?|dispatch\w*|techs?|technicians?|crews?|employees?|staff|team|payments?|paid|owe[sd]?|revenue|profit\w*|pric\w*|charge\w*|catalog|services?|repairs?|install\w*|maintenance|tune-?ups?|warrant\w*|permits?|furnaces?|hvac|a\/?c|air\s+condition\w*|heat\s+pumps?|water\s+heaters?|plumb\w*|electric\w*|leads?|reviews?|marketing|business|company|shop|trucks?|vans?|routes?|parts|materials?|expenses?|mileage|payroll|tax(?:es)?|follow[-\s]?ups?|reminders?)\b/i;

/** General-knowledge / trivia question shapes. */
const TRIVIA_RE =
  /\b(?:capital\s+(?:city\s+)?of|trivia|fun\s+fact|who\s+won\s+the|who\s+(?:invented|discovered|painted|wrote)|meaning\s+of\s+life|how\s+far\s+(?:away\s+)?is\s+the\s+(?:moon|sun)|tallest\s+(?:mountain|building)|largest\s+(?:country|ocean|planet))\b/i;

export function isOffTopicRequest(text: string): boolean {
  if (BUSINESS_TERM_RE.test(text)) return false;
  return CREATIVE_REQUEST_RE.test(text) || TRIVIA_RE.test(text);
}

/** The decline: one line, on brand, pointing at what the assistant does. */
export const OFF_TOPIC_DECLINE =
  "I'll stick to the business on this one — that's outside what I do here. " +
  'I can draft estimates and invoices, schedule jobs, add customers, and tell you who owes you. What do you need?';
