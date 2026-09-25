/**
 * Plan-gated features. Plans otherwise differ by users and included AI
 * minutes; QuickBooks sync is the one Growth-only feature (it is sold that
 * way on the marketing site). A tenant with no recorded plan yet — before
 * checkout — gets Starter's features.
 */
import type { Pool } from 'pg';
import { AppError } from '../shared/errors';
import type { CallPlanId } from './call-usage-pricing';

export function planIncludesQuickBooks(planId: CallPlanId | null): boolean {
  return planId === 'growth';
}

/** The tenant's mirrored Rivet plan (tenants.plan_id), or null before checkout. */
export async function readTenantPlanId(pool: Pool, tenantId: string): Promise<CallPlanId | null> {
  const res = await pool.query<{ plan_id: CallPlanId | null }>(
    `SELECT plan_id FROM tenants WHERE id = $1`,
    [tenantId],
  );
  return res.rows[0]?.plan_id ?? null;
}

export function quickBooksUpgradeRequired(): AppError {
  return new AppError(
    'PLAN_UPGRADE_REQUIRED',
    'QuickBooks sync is part of Growth. Upgrade to connect your Intuit account.',
    403,
    { feature: 'quickbooks', requiredPlan: 'growth' },
  );
}
