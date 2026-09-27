/**
 * #1399 (QA 2026-09-26 §17) — deterministic chat-turn guards that run BEFORE
 * the intent classifier on POST /api/assistant/chat. Pure: no I/O, no LLM.
 *
 * - Life safety: a typed gas / carbon-monoxide / fire report gets the same
 *   E1 advice the phone path speaks (`classifyCallerSafety` →
 *   `LIFE_SAFETY_E1_ADVICE`), and nothing is drafted or booked. Before this,
 *   the chat classified it `emergency_dispatch` and the honesty guard replied
 *   "I can't do that from here yet" with no safety advice at all.
 * - Bulk money mutations: "mark every invoice paid" became a follow-up
 *   proposal. Money moves one record at a time, each behind its own
 *   approval; a request to mark / void / refund / write off ALL of them is
 *   refused outright, never turned into a proposal.
 */
import {
  classifyCallerSafety,
  LIFE_SAFETY_E1_ADVICE,
} from '../agents/customer-calling/emergency-tier';

/** The chat reply for an E1 life-safety turn, or null when the turn is not E1. */
export function chatLifeSafetyReply(text: string): string | null {
  const safety = classifyCallerSafety(text, {});
  if (safety.tier !== 'E1') return null;
  return `${LIFE_SAFETY_E1_ADVICE} I haven't booked or drafted anything for this.`;
}

const BULK_QUANTIFIER = String.raw`\b(?:all|every|each)\b`;
const MONEY_RECORD = String.raw`\b(?:invoices?|bills?|payments?|balances?)\b`;
// Verbs that move money on their own ("void all the open invoices").
const MONEY_VERB = String.raw`\b(?:void|cancel|delete|remove|refund|forgive|zero\s+out|write\s*off|writeoff)\b`;
// Status verbs are only a money move when the status is "paid" ("mark every
// invoice paid"); "set up reminders for every invoice" is not.
const PAID_VERB = String.raw`\b(?:mark|set|record|flag|close\s+out)\b`;
const IN_ONE_SENTENCE = String.raw`[^.?!]*?`;
const BULK_MONEY_MUTATION = new RegExp(
  `${MONEY_VERB}${IN_ONE_SENTENCE}${BULK_QUANTIFIER}${IN_ONE_SENTENCE}${MONEY_RECORD}`,
  'i',
);
const BULK_MARK_PAID = new RegExp(
  `${PAID_VERB}${IN_ONE_SENTENCE}${BULK_QUANTIFIER}${IN_ONE_SENTENCE}${MONEY_RECORD}${IN_ONE_SENTENCE}\\bpaid\\b`,
  'i',
);

/** The chat refusal for a bulk money mutation, or null when the turn is not one. */
export function chatBulkMoneyRefusal(text: string): string | null {
  if (!BULK_MONEY_MUTATION.test(text) && !BULK_MARK_PAID.test(text)) return null;
  return (
    "I can't change money on every invoice at once, so I haven't changed anything. " +
    'Tell me one invoice at a time (for example, "mark INV-0012 paid") and I\'ll draft it for your approval.'
  );
}
