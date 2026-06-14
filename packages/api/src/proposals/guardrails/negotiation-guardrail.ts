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
import {
  negotiationCallbackPayloadSchema,
  type NegotiationAskType,
  type NegotiationCustomerContext as NegotiationCustomerContextPayload,
} from '@ai-service-os/shared';
import {
  formatRecencyLabel,
  type CustomerNegotiationContext,
} from '../../customers/customer-negotiation-context';

// NegotiationAskType is owned by the shared contract (single source of truth);
// re-exported so the api consumers keep importing it from the guardrail.
export type { NegotiationAskType };

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

/**
 * Deterministic, auditable customer value tier used to FRAME (not decide) the
 * owner recommendation. Value comes from collected lifetime cents and completed
 * jobs; recency only colours the wording. No discount is ever recommended — V1
 * blocks discounts; this just tells the owner who they're talking to.
 */
export type CustomerValueTier = 'valued_repeat' | 'established' | 'new_or_unknown';

/** $1,000 collected lifetime OR 3+ completed jobs reads as a valued repeat. */
const VALUED_REPEAT_LTV_CENTS = 100_000;
const VALUED_REPEAT_JOB_COUNT = 3;

export function customerValueTier(ctx: CustomerNegotiationContext): CustomerValueTier {
  if (
    ctx.lifetimeValueCents >= VALUED_REPEAT_LTV_CENTS ||
    ctx.jobsCompletedCount >= VALUED_REPEAT_JOB_COUNT
  ) {
    return 'valued_repeat';
  }
  if (ctx.lifetimeValueCents > 0 || ctx.jobsCompletedCount > 0) {
    return 'established';
  }
  return 'new_or_unknown';
}

/** Integer-cents → "$1,250" / "$1,250.50" for owner-facing prose (no float math). */
function formatUsdFromCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  const dollarStr = dollars.toLocaleString('en-US');
  return rem === 0 ? `${sign}$${dollarStr}` : `${sign}$${dollarStr}.${String(rem).padStart(2, '0')}`;
}

/**
 * A one-sentence value + recency framing that surfaces the customer's lifetime
 * value and recency so the owner can weigh the ask. Never proposes a discount.
 */
export function customerValueFraming(ctx: CustomerNegotiationContext): string {
  const ltv = formatUsdFromCents(ctx.lifetimeValueCents);
  const recency = formatRecencyLabel(ctx.lastSeenAt);
  const jobs = `${ctx.jobsCompletedCount} completed ${ctx.jobsCompletedCount === 1 ? 'job' : 'jobs'}`;
  switch (customerValueTier(ctx)) {
    case 'valued_repeat':
      return `Worth noting: valued repeat customer — ${ltv} lifetime, ${jobs}, last seen ${recency}. Keeping them happy may matter more than this one ask; a small courtesy is your call.`;
    case 'established':
      return `Context: some history — ${ltv} lifetime, ${jobs}, last seen ${recency}. Weigh that, but don't feel pressured to discount.`;
    case 'new_or_unknown':
      return `Context: no real history yet (${recency}). Nothing here justifies a concession — hold firm.`;
  }
}

/**
 * The owner recommendation for a detected ask type (or a generic fallback),
 * optionally enriched with the customer's value + recency framing.
 */
export function recommendNegotiationResponse(
  askType: NegotiationAskType | null,
  ctx?: CustomerNegotiationContext | null,
): string {
  const base =
    askType === null
      ? 'The customer pushed on price or terms. The AI did not concede — review and respond on your terms.'
      : RECOMMENDATIONS[askType];
  return ctx ? `${base} ${customerValueFraming(ctx)}` : base;
}

/**
 * Shared owner-callback content for a detected negotiation, used by every
 * surface that routes a negotiation to the owner: the voice-action-router task
 * handler, the inbound-SMS handler, and the live-call voice-turn processor. A
 * single builder keeps the proposal payload, summary, and review marker
 * byte-identical across channels.
 */
export interface NegotiationCallbackContent {
  /** `callback` proposal payload (capture-class; never auto-executes). */
  payload: Record<string, unknown>;
  summary: string;
  explanation: string;
  askType: NegotiationAskType | null;
}

export interface BuildNegotiationCallbackInput {
  /** Text used for deterministic ask-type detection (the customer's words). */
  detectText: string;
  /** The verbatim ask stored on the proposal (defaults to detectText). */
  askText?: string;
  customerName?: string;
  /** Full transcript / message body for the owner to read. */
  transcript?: string;
  conversationId?: string;
  /** Resolved customer history (LTV + recency). Null/omitted for an unknown caller. */
  customerContext?: CustomerNegotiationContext | null;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
}

export function buildNegotiationCallbackContent(
  input: BuildNegotiationCallbackInput,
): NegotiationCallbackContent {
  const askText = (input.askText ?? input.detectText).trim();
  const askType = detectNegotiationAskType(`${input.detectText} ${askText}`);
  const who = input.customerName ?? 'the customer';
  const ctx = input.customerContext ?? null;
  // Map the domain context (Date) to the serialized payload shape (ISO + label).
  const customerContext: NegotiationCustomerContextPayload | null = ctx
    ? {
        lifetimeValueCents: ctx.lifetimeValueCents,
        lastSeenAt: ctx.lastSeenAt ? ctx.lastSeenAt.toISOString() : null,
        recencyLabel: formatRecencyLabel(ctx.lastSeenAt),
        jobsCompletedCount: ctx.jobsCompletedCount,
      }
    : null;
  const payload: Record<string, unknown> = {
    reason: 'customer_negotiation_followup',
    negotiationAskType: askType ?? 'general',
    askText,
    recommendation: recommendNegotiationResponse(askType, ctx),
    customerContext,
    ...(input.transcript ? { transcript: input.transcript } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    _meta: {
      // 'medium' is neutral (only low/very_low gate auto-approval); the marker
      // is the payload — it makes every review surface flag the guardrail.
      overallConfidence: 'medium',
      markers: [{ path: 'recommendation', reason: NEGOTIATION_GUARDRAIL_MARKER_REASON }],
    },
  };
  // Validate against the shared contract so the negotiation callback payload is
  // Zod-checked like every other proposal (it was previously an untyped bag).
  negotiationCallbackPayloadSchema.parse(payload);
  return {
    payload,
    summary: `${capitalize(negotiationAskLabel(askType))} from ${who} — AI didn't negotiate; call back`,
    explanation:
      'The AI detected price/scope/terms pushback, declined to negotiate, and indicated it would check with you. Decide on your terms and follow up.',
    askType,
  };
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
