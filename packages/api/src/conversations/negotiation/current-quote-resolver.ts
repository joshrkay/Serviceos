/**
 * U5a (P2-036 V2) — Current-quote resolver.
 *
 * When a customer haggles over price, the discount evaluator
 * (src/proposals/guardrails/discount-evaluator.ts) needs two inputs grounded in
 * reality: the price the customer is actually looking at (`currentQuotedCents`)
 * and whether that quote's pricing is catalog-grounded (so the floor can be
 * trusted). This module resolves both from the customer's estimate history.
 *
 * WHAT "CURRENT QUOTE" MEANS
 *   The estimate the customer has actually SEEN and is negotiating over: one in
 *   `sent` or `accepted` status. Drafts / rejected / expired estimates were
 *   never a live offer to this customer, so they can't be what's being haggled.
 *   When a customer has more than one live estimate (across jobs), the most
 *   RECENT one wins — that's the price in front of them right now.
 *
 * FAIL-SAFE TO "NO QUOTE"
 *   Every repo call is wrapped: a thrown error, a missing optional repo method,
 *   no matching customer, no jobs, no live estimate, or a non-positive total all
 *   resolve to `null`. The negotiation caller treats `null` as "no quote on
 *   record → route to the owner" — never as an opportunity to guess a price.
 *   We never fabricate a quoted figure the customer didn't see.
 *
 * Money is integer cents. Pure selection (status filter + most-recent pick) is
 * factored into `selectCurrentQuoteEstimate` so it's unit-testable without repos.
 */
import {
  Estimate,
  EstimateRepository,
  isEstimateCatalogGrounded,
} from '../../estimates/estimate';
import { JobRepository } from '../../jobs/job';

/** Estimate statuses that represent a quote the customer has actually seen. */
const LIVE_QUOTE_STATUSES: ReadonlySet<Estimate['status']> = new Set([
  'sent',
  'accepted',
]);

export interface CurrentQuote {
  estimateId: string;
  /** The estimate's total — the price the customer sees. Integer cents, > 0. */
  quotedCents: number;
  /** From `isEstimateCatalogGrounded(estimate)` — the grounding signal. */
  catalogGrounded: boolean;
}

export interface CurrentQuoteResolver {
  resolve(tenantId: string, customerId: string): Promise<CurrentQuote | null>;
}

/**
 * Effective sort key for "most recent": prefer `updatedAt`, fall back to
 * `createdAt`. A revise/re-send bumps `updatedAt`, so it best reflects the last
 * time the quote in front of the customer changed.
 */
function recencyOf(estimate: Estimate): number {
  return (estimate.updatedAt ?? estimate.createdAt).getTime();
}

/**
 * Pure selection: from a set of a customer's estimates, pick the single quote
 * the customer is currently looking at — the most-recent estimate in a live
 * (`sent` / `accepted`) status. Returns `null` when none qualify.
 *
 * Tie-break is deterministic: estimates are compared by `recencyOf` (updatedAt
 * with createdAt fallback), most-recent first.
 */
export function selectCurrentQuoteEstimate(
  estimates: Estimate[],
): Estimate | null {
  let best: Estimate | null = null;
  for (const estimate of estimates) {
    if (!LIVE_QUOTE_STATUSES.has(estimate.status)) continue;
    if (best === null || recencyOf(estimate) > recencyOf(best)) {
      best = estimate;
    }
  }
  return best;
}

export class DefaultCurrentQuoteResolver implements CurrentQuoteResolver {
  private readonly jobRepo: JobRepository;
  private readonly estimateRepo: EstimateRepository;

  constructor(deps: { jobRepo: JobRepository; estimateRepo: EstimateRepository }) {
    this.jobRepo = deps.jobRepo;
    this.estimateRepo = deps.estimateRepo;
  }

  async resolve(
    tenantId: string,
    customerId: string,
  ): Promise<CurrentQuote | null> {
    if (!tenantId || !customerId) return null;

    // 1. The customer's jobs. findByCustomer is optional on the repo
    //    interface; a missing implementation means we can't resolve a quote.
    if (!this.jobRepo.findByCustomer) return null;
    const jobs = await safe(() =>
      this.jobRepo.findByCustomer!(tenantId, customerId),
    );
    if (!jobs || jobs.length === 0) return null;

    // 2. Batch-fetch every estimate across those jobs.
    const jobIds = jobs.map((job) => job.id);
    const estimates = await safe(() =>
      this.estimateRepo.findByJobs(tenantId, jobIds),
    );
    if (!estimates || estimates.length === 0) return null;

    // 3. Pick the live quote the customer is currently looking at.
    const current = selectCurrentQuoteEstimate(estimates);
    if (!current) return null;

    // 4. Don't hand the evaluator a non-positive base — it has nothing to
    //    discount against, so this is "no quote" too.
    const quotedCents = current.totals.totalCents;
    if (quotedCents <= 0) return null;

    return {
      estimateId: current.id,
      quotedCents,
      catalogGrounded: isEstimateCatalogGrounded(current),
    };
  }
}

/**
 * Run a repo call, returning `null` on any thrown error so a transient repo
 * failure degrades to "no quote → route to owner" rather than crashing the
 * negotiation path.
 */
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}
