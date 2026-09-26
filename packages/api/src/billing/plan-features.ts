/**
 * Plan-gated features. Plans otherwise differ by users and included AI
 * minutes; QuickBooks sync is the one Growth-only feature (it is sold that
 * way on the marketing site). A tenant with no recorded plan yet — before
 * checkout — gets Starter's features.
 */
import type { Pool } from 'pg';
import { AppError } from '../shared/errors';
import type { CallPlanId } from './call-usage-pricing';
import { readTenantBillingState } from './tenant-billing-state';

export function planIncludesQuickBooks(planId: CallPlanId | null): boolean {
  return planId === 'growth';
}

/** The tenant's mirrored Rivet plan (tenants.plan_id), or null before checkout. */
export async function readTenantPlanId(pool: Pool, tenantId: string): Promise<CallPlanId | null> {
  return (await readTenantBillingState(pool, tenantId))?.planId ?? null;
}

export function quickBooksUpgradeRequired(): AppError {
  return new AppError(
    'PLAN_UPGRADE_REQUIRED',
    'QuickBooks sync is part of Growth. Upgrade to connect your Intuit account.',
    403,
    { feature: 'quickbooks', requiredPlan: 'growth' },
  );
}
