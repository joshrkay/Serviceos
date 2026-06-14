/**
 * P2-036 / N-003 — Postgres read for customer negotiation context (LTV + recency).
 *
 * Tenant-scoped via RLS (`withTenant`); `tenant_id` is also the first predicate
 * in every sub-query for defense-in-depth, matching the repository conventions.
 * Joins mirror `reputation/match-customer.ts`: invoices and appointments carry
 * `job_id`, not `customer_id`, so both reach the customer via `jobs.customer_id`.
 * This is a pure read — no mutation, no audit event.
 */
import { Pool, PoolClient } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  CustomerNegotiationContext,
  CustomerNegotiationContextProvider,
} from './customer-negotiation-context';

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
