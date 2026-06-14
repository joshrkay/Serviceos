/**
 * P2-036 / N-003 — customer negotiation context (lifetime value + recency).
 *
 * When the negotiation guardrail routes a haggling customer to the owner, the
 * owner-facing recommendation must reflect WHO is asking: a high-value repeat
 * customer warrants a different call than a first-time caller (PRD: "don't
 * discount: high-LTV customer who'll come back; offer a courtesy instead").
 * This module is the read that surfaces that history.
 *
 * It is a pure read — no mutation, no audit event. All money is integer cents.
 * The lookup is tenant-scoped via RLS (`withTenant`); `tenant_id` is also the
 * first predicate in every sub-query for defense-in-depth, matching the
 * repository conventions used across the codebase.
 *
 * Joins mirror `reputation/match-customer.ts`: invoices and appointments carry
 * `job_id`, not `customer_id`, so both reach the customer via `jobs.customer_id`.
 */
import { Pool, PoolClient } from 'pg';
import { PgBaseRepository } from '../db/pg-base';

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

/** Context for an unknown caller (no resolved customer) — used by the wiring layer. */
export const EMPTY_CUSTOMER_NEGOTIATION_CONTEXT: CustomerNegotiationContext = {
  lifetimeValueCents: 0,
  lastSeenAt: null,
  jobsCompletedCount: 0,
};

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

export class PgCustomerNegotiationContextProvider
  extends PgBaseRepository
  implements CustomerNegotiationContextProvider
{
  constructor(pool: Pool) {
    super(pool);
  }

  async getContext(tenantId: string, customerId: string): Promise<CustomerNegotiationContext> {
    return this.withTenant(tenantId, async (client: PoolClient) => {
      const result = await client.query(
        `SELECT
           COALESCE((
             SELECT SUM(i.amount_paid_cents)
             FROM invoices i
             JOIN jobs j ON j.id = i.job_id
             WHERE i.tenant_id = $1
               AND j.customer_id = $2
               AND i.status NOT IN ('void', 'canceled')
           ), 0)::bigint AS lifetime_value_cents,
           (
             SELECT COUNT(*)
             FROM jobs j
             WHERE j.tenant_id = $1
               AND j.customer_id = $2
               AND j.status = 'completed'
           )::int AS jobs_completed_count,
           GREATEST(
             (
               SELECT MAX(a.scheduled_start)
               FROM appointments a
               JOIN jobs j ON j.id = a.job_id
               WHERE a.tenant_id = $1 AND j.customer_id = $2
             ),
             (
               SELECT MAX(p.paid_at)
               FROM payments p
               JOIN invoices i ON i.id = p.invoice_id
               JOIN jobs j ON j.id = i.job_id
               WHERE p.tenant_id = $1
                 AND j.customer_id = $2
                 AND p.status = 'completed'
             )
           ) AS last_seen_at`,
        [tenantId, customerId],
      );
      const row = (result.rows[0] ?? {}) as {
        lifetime_value_cents?: string | number | null;
        jobs_completed_count?: string | number | null;
        last_seen_at?: string | null;
      };
      return {
        lifetimeValueCents: Number(row.lifetime_value_cents ?? 0),
        lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : null,
        jobsCompletedCount: Number(row.jobs_completed_count ?? 0),
      };
    });
  }
}
