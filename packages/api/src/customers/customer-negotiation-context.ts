/**
 * P2-036 / N-003 — customer negotiation context (lifetime value + recency).
 *
 * When the negotiation guardrail routes a haggling customer to the owner, the
 * owner-facing recommendation must reflect WHO is asking: a high-value repeat
 * customer warrants a different call than a first-time caller (PRD: "don't
 * discount: high-LTV customer who'll come back; offer a courtesy instead").
 *
 * This module is the PURE domain surface — the shape, the empty fallback, and
 * the recency-label formatter — with no I/O. The tenant-scoped read lives in
 * `pg-customer-negotiation-context.ts` (mirroring `customer.ts` / `pg-customer.ts`)
 * so the deterministic guardrail can import the formatter without pulling `pg`.
 * All money is integer cents.
 */

export interface CustomerNegotiationContext {
  /** Sum of `amount_paid_cents` across the customer's non-void invoices. Integer cents. */
  lifetimeValueCents: number;
  /**
   * Most recent customer interaction — the later of the last appointment
   * (`scheduled_start`) and the last completed payment (`paid_at`), in UTC.
   * `null` for a brand-new caller with no history.
   */
  lastSeenAt: Date | null;
  /** Number of jobs in the `completed` status for this customer. */
  jobsCompletedCount: number;
}

export interface CustomerNegotiationContextProvider {
  getContext(tenantId: string, customerId: string): Promise<CustomerNegotiationContext>;
}

/**
 * A short, human, audit-friendly recency phrase for the owner ("3 weeks ago").
 * Relative (not absolute), so it is timezone-independent — the owner reads it
 * in an SMS / voice readback where "about a month ago" is the useful signal,
 * not a precise local timestamp. Pure + clock-injectable for tests.
 */
export function formatRecencyLabel(lastSeenAt: Date | null, now: Date = new Date()): string {
  if (!lastSeenAt) return 'new customer';
  const ms = now.getTime() - lastSeenAt.getTime();
  // Future-dated row (clock skew): treat as just-now, never report a negative age.
  if (ms < 0) return 'today';
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 31) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 60) return 'last month';
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? 'about a year ago' : `${years} years ago`;
}
