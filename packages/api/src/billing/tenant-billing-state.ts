/**
 * The one read of a tenant's billing snapshot: subscription status, Rivet
 * plan, the mirrored Stripe billing period, and the owner (for funnel events
 * and emails). Callers decide what it means — the voice gate, usage summary,
 * usage alerts, plan features and the trial nudge all start here.
 */
import type { Pool } from 'pg';
import type { CallPlanId } from './call-usage-pricing';

export interface TenantBillingState {
  /** Mirror of Stripe subscription.status; null before checkout. */
  status: string | null;
  /** Rivet plan from the subscription price; null before checkout. */
  planId: CallPlanId | null;
  /** Current Stripe billing period; null until the first subscription webhook. */
  period: { start: Date; end: Date } | null;
  ownerId: string | null;
  ownerEmail: string | null;
}

export async function readTenantBillingState(
  pool: Pool,
  tenantId: string,
): Promise<TenantBillingState | null> {
  const res = await pool.query<{
    subscription_status: string | null;
    plan_id: CallPlanId | null;
    current_period_start: Date | null;
    current_period_end: Date | null;
    owner_id: string | null;
    owner_email: string | null;
  }>(
    `SELECT subscription_status, plan_id, current_period_start, current_period_end,
            owner_id, owner_email
       FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    status: row.subscription_status,
    planId: row.plan_id,
    period:
      row.current_period_start && row.current_period_end
        ? { start: new Date(row.current_period_start), end: new Date(row.current_period_end) }
        : null,
    ownerId: row.owner_id,
    ownerEmail: row.owner_email,
  };
}
