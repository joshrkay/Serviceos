/**
 * Rivet P2 F-1 — Supervisor Agent v1: deterministic per-tenant policy
 * engine (pure half).
 *
 * `evaluateSupervisorPolicy` is a PURE function: (proposal facts +
 * counters, rules) → verdict. No I/O, no LLM, no clock. The async
 * loading of rules/counters lives in `service.ts`; the advisory LLM
 * annotator lives in `workers/supervisor-review-worker.ts` and is
 * entirely decoupled from this engine.
 *
 * Structural safety invariant: the engine can only DOWNGRADE
 * permissiveness relative to the existing `decideInitialStatus`
 * behavior. The verdict vocabulary has no "approve"/upgrade member and
 * `capInitialStatus` is monotone non-increasing on the status order
 * draft < ready_for_review < approved — money/irreversible proposals
 * therefore can never be upgraded by a supervisor policy, by
 * construction. Pinned in test/proposals/supervisor/policy.test.ts.
 *
 * Plan F-1 rule subset shipped in v1: budget caps + class/type rules.
 * Quiet-hours and deviation-threshold keys are DEFERRED — add them to
 * `SupervisorRules` (all-optional, permissive-when-unset) when they
 * land so old persisted `rules` JSONB stays valid.
 */

/** Action-class vocabulary mirrored (type-only) from proposals/proposal.ts. */
export type SupervisorActionClass = 'capture' | 'comms' | 'money' | 'irreversible';

/**
 * Per-tenant supervisor rule set, persisted as `supervisor_policies.rules`
 * JSONB. EVERY key is optional and an unset key is permissive — so the
 * empty object is exact parity with pre-supervisor behavior.
 */
export interface SupervisorRules {
  /**
   * Cap on the total executed money-class spend per UTC day. When the
   * already-executed spend plus this proposal's amount would exceed the
   * cap, the proposal is forced to human review (never auto-approved).
   */
  dailySpendCapCents?: number;
  /** Hard per-proposal amount ceiling — anything above is blocked to 'draft'. */
  perProposalCapCents?: number;
  /** Budget of machine auto-approvals per UTC hour; at/over budget forces review. */
  maxAutoApprovalsPerHour?: number;
  /** Proposal types the tenant has blocked outright (always 'draft'). */
  blockedProposalTypes?: string[];
}

/**
 * Permissive parity defaults: all caps unset → `evaluateSupervisorPolicy`
 * always returns 'allow', i.e. exactly today's behavior.
 */
export const DEFAULT_SUPERVISOR_RULES: SupervisorRules = {};

/**
 * 'allow'        → unchanged path (whatever decideInitialStatus said).
 * 'force_review' → status capped at 'ready_for_review' (never 'approved').
 * 'block'        → created in 'draft' (auto-approval AND review-queue
 *                  routing suppressed); marker + audit explain why.
 *
 * Deliberately NO upgrade member — see the structural invariant above.
 */
export type SupervisorVerdict = 'allow' | 'force_review' | 'block';

export interface SupervisorDecision {
  verdict: SupervisorVerdict;
  /** Human-readable rule callouts; rendered into payload._meta.markers. */
  reasons: string[];
}

export interface SupervisorPolicyInput {
  proposalType: string;
  actionClass: SupervisorActionClass;
  /**
   * Headline money value of the payload in integer cents (via the shared
   * `payloadHeadlineCents`), or null when the payload carries no money.
   */
  amountCents: number | null;
  /** Current-window counter snapshot (UTC day / UTC hour windows, v1). */
  counters: {
    dailySpendCents: number;
    autoApprovalsThisHour: number;
  };
}

/**
 * Evaluate the tenant's supervisor rules against one proposal-creation
 * event. Pure and total: every rule with an unset key is skipped, all
 * tripped rules contribute a reason, and the strongest verdict wins
 * (block > force_review > allow).
 */
export function evaluateSupervisorPolicy(
  input: SupervisorPolicyInput,
  rules: SupervisorRules,
): SupervisorDecision {
  const blockReasons: string[] = [];
  const reviewReasons: string[] = [];

  if (rules.blockedProposalTypes && rules.blockedProposalTypes.includes(input.proposalType)) {
    blockReasons.push(`proposal type '${input.proposalType}' is blocked by tenant policy`);
  }

  if (
    rules.perProposalCapCents !== undefined &&
    input.amountCents !== null &&
    input.amountCents > rules.perProposalCapCents
  ) {
    blockReasons.push(
      `amount ${input.amountCents}c exceeds per-proposal cap ${rules.perProposalCapCents}c`,
    );
  }

  if (rules.dailySpendCapCents !== undefined) {
    const projected = input.counters.dailySpendCents + (input.amountCents ?? 0);
    if (projected > rules.dailySpendCapCents) {
      reviewReasons.push(
        `projected daily spend ${projected}c exceeds daily spend cap ${rules.dailySpendCapCents}c`,
      );
    }
  }

  if (
    rules.maxAutoApprovalsPerHour !== undefined &&
    input.counters.autoApprovalsThisHour >= rules.maxAutoApprovalsPerHour
  ) {
    reviewReasons.push(
      `hourly auto-approvals budget exhausted (${input.counters.autoApprovalsThisHour}/${rules.maxAutoApprovalsPerHour})`,
    );
  }

  if (blockReasons.length > 0) {
    return { verdict: 'block', reasons: [...blockReasons, ...reviewReasons] };
  }
  if (reviewReasons.length > 0) {
    return { verdict: 'force_review', reasons: reviewReasons };
  }
  return { verdict: 'allow', reasons: [] };
}

/**
 * The three statuses `decideInitialStatus` can produce. (Type-local so
 * this module stays import-free of proposal.ts at runtime — proposal.ts
 * imports US for the createProposal hook point.)
 */
export type InitialProposalStatus = 'draft' | 'ready_for_review' | 'approved';

/**
 * Apply a supervisor verdict to the status `decideInitialStatus` chose.
 * Monotone non-increasing on draft < ready_for_review < approved — the
 * structural "downgrade-only" guarantee (see module header).
 */
export function capInitialStatus(
  verdict: SupervisorVerdict,
  baseline: InitialProposalStatus,
): InitialProposalStatus {
  switch (verdict) {
    case 'allow':
      return baseline;
    case 'force_review':
      return baseline === 'approved' ? 'ready_for_review' : baseline;
    case 'block':
      return 'draft';
  }
}
