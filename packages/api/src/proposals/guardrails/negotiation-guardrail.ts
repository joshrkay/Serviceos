/**
 * N-003 (P2-036) — Negotiation guardrail: deterministic ask-type detection.
 *
 * Locked product decision #7: the AI never discounts, never commits to scope
 * changes, never promises a person. When a customer pushes on price, scope, or
 * terms, the agent must NOT answer substantively — it acknowledges and routes
 * the ask to the owner with a recommendation.
 *
 * The `negotiation` *intent* is LLM-classified by the intent classifier
 * (src/ai/orchestration/intent-classifier.ts). This module REFINES it into a
 * specific ask type with a deterministic, auditable keyword list — the same
 * philosophy as `complaintSeverity` (src/ai/tasks/complaint-task.ts): a
 * classification that drives owner-facing routing and a review marker must be a
 * fixed, inspectable rule, not an LLM mood read.
 */

export type NegotiationAskType =
  | 'discount'
  | 'scope_change'
  | 'refund_leverage'
  | 'manager_escalation'
  | 'deadline_threat';

/** Marker reason stamped on the owner proposal's `_meta` so review surfaces flag it. */
export const NEGOTIATION_GUARDRAIL_MARKER_REASON = 'negotiation_guardrail';

/**
 * Priority-ordered detectors. Order matters: "refund or I'll leave a 1-star
 * review" is both a refund lever and a threat — we classify the concrete lever
 * (refund) ahead of the generic pressure tactic because the owner
 * recommendation differs. `deadline_threat` is the catch-all pressure tactic,
 * checked last.
 */
const NEGOTIATION_PATTERNS: ReadonlyArray<{
  askType: NegotiationAskType;
  patterns: ReadonlyArray<RegExp>;
}> = [
  {
    askType: 'discount',
    patterns: [
      /\bdiscount(s|ed|ing)?\b/i,
      // "knock/take/shave [fifty bucks] off" — allow an amount between the verb
      // and "off" without crossing a sentence boundary.
      /\b(knock|take|shave)\b[^.?!]{0,20}\boff\b/i,
      /\b(lower|reduce|drop|cut)\s+(the\s+)?(price|cost|rate|quote|estimate|bill)\b/i,
      /\btoo\s+(expensive|much|high|pricey|steep)\b/i,
      /\b(give|cut)\s+me\s+a\s+(deal|break)\b/i,
      /\bbest\s+(price|you\s+can\s+do)\b/i,
      /\bprice[-\s]?match\b/i,
      /\b(coupons?|promo(tion)?s?|specials?)\b/i,
    ],
  },
  {
    askType: 'scope_change',
    patterns: [
      /\b(throw|toss)\s+in\b/i,
      /\b(for\s+free|at\s+no\s+(charge|cost)|free\s+of\s+charge|on\s+the\s+house)\b/i,
      /\bcomp(ed|\s+(it|that|me))?\b/i,
      /\bwhile\s+you('re|\s+are)\s+(here|at\s+it)\b/i,
    ],
  },
  {
    askType: 'refund_leverage',
    patterns: [
      /\b(refund|reimburse(ment)?)\b/i,
      /\bmoney\s+back\b/i,
      /\bcharge\s*backs?\b/i,
      /\bpartial\s+(refund|credit)\b/i,
    ],
  },
  {
    askType: 'manager_escalation',
    patterns: [
      /\b(talk|speak|escalate)\s+to\s+(the\s+)?(owner|manager|boss|supervisor)\b/i,
      /\bwho('s| is)\s+(the\s+)?(owner|in\s+charge)\b/i,
    ],
  },
  {
    askType: 'deadline_threat',
    patterns: [
      /\b(1|one)[\s-]*star\b/i,
      /\b(bad|negative|terrible|poor)\s+review\b/i,
      /\bleave\s+(a|you)\b.*\breview\b/i,
      /\b(go|take\s+my\s+business)\s+(else\s*where|to\s+(someone|somebody)\s+else|to\s+a\s+competitor)\b/i,
      /\b(unless|if\s+you\s+(don'?t|won'?t|can'?t))\b.*\b(cancel|leave|else\s*where|review)\b/i,
    ],
  },
];

/**
 * Detect the negotiation ask type from the customer's words. Returns null when
 * no specific pattern matches (the caller treats null as a generic pricing
 * pushback — the LLM already decided this is a negotiation).
 */
export function detectNegotiationAskType(text: string): NegotiationAskType | null {
  if (!text) return null;
  for (const entry of NEGOTIATION_PATTERNS) {
    if (entry.patterns.some((rx) => rx.test(text))) return entry.askType;
  }
  return null;
}

/** Owner-facing recommendation seed per ask type (deterministic, auditable). */
const RECOMMENDATIONS: Record<NegotiationAskType, string> = {
  discount:
    "Don't auto-discount. If they're high-value or repeat, consider a small courtesy (e.g. waive the trip fee) rather than cutting the quote — your call.",
  scope_change:
    "Don't commit to extra work for free. Price the add-on as a separate line if you want it, or politely decline.",
  refund_leverage:
    "Don't approve a refund on the spot. Review the job first; offer a partial credit only if the work warrants it.",
  manager_escalation:
    'They asked for you directly — call them back yourself. The AI did not quote or concede anything.',
  deadline_threat:
    "They're applying pressure (a review or walk-away threat). Don't be rushed into a discount; decide on your terms and respond.",
};

/** The owner recommendation for a detected ask type (or a generic fallback). */
export function recommendNegotiationResponse(askType: NegotiationAskType | null): string {
  if (askType === null) {
    return 'The customer pushed on price or terms. The AI did not concede — review and respond on your terms.';
  }
  return RECOMMENDATIONS[askType];
}

/** Short human label for proposal summaries. */
export function negotiationAskLabel(askType: NegotiationAskType | null): string {
  switch (askType) {
    case 'discount':
      return 'discount request';
    case 'scope_change':
      return 'scope-change request';
    case 'refund_leverage':
      return 'refund request';
    case 'manager_escalation':
      return 'owner/manager request';
    case 'deadline_threat':
      return 'pressure/ultimatum';
    case null:
      return 'pricing pushback';
  }
}
