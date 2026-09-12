import type { Pool } from 'pg';
import type { SettingsRepository } from '../settings/settings';

/**
 * Per-tenant configuration for the weekly-feedback sweep.
 *
 * These three resolvers were inlined as closures at the sweep's wiring site in
 * `app.ts`, which made them untestable: every test of the sweep substituted its
 * own hand-built arrays and maps, so a regression in the production closures —
 * one that stopped scoping by the tenant id it was handed — could not fail any
 * test. That is the same defect D-032 was raised for, one layer down from the
 * tenant *selector* (`tenants/list-tenant-ids.ts`): the sweep was proven to
 * enumerate every tenant, and then proven against config that was not the
 * config production reads.
 *
 * A sweep serving N tenants in one pass must read N tenants' worth of
 * configuration. Exercising these against real rows is what makes that
 * claim (PRD §11.0e, tenant grade T3) evidence rather than a prediction.
 */

/**
 * The tenant's owner email — the weekly digest recipient. Null when the tenant
 * has none, which the worker treats as "skip this tenant".
 *
 * Distinct from `auth/resolve-owner-email.ts`, which resolves the *signed-in*
 * owner's address from a request (preferring the Clerk claim, then the users
 * row). A background sweep holds a tenant id and no request, so it reads the
 * tenant row directly.
 */
export async function resolveTenantOwnerEmail(
  pool: Pool,
  tenantId: string,
): Promise<string | null> {
  const result = await pool.query<{ owner_email: string | null }>(
    'SELECT owner_email FROM tenants WHERE id = $1',
    [tenantId],
  );
  return result.rows[0]?.owner_email ?? null;
}

/**
 * The weekly-feedback opt-out gate. Absent settings, or an unset flag, mean
 * enabled — the email is opt-OUT, so a tenant that has never touched the
 * setting still receives it. Only an explicit `false` skips the tenant.
 */
export async function isWeeklyFeedbackEnabledForTenant(
  settingsRepo: SettingsRepository,
  tenantId: string,
): Promise<boolean> {
  const settings = await settingsRepo.findByTenant(tenantId);
  return settings?.weeklyFeedbackEnabled !== false;
}

/** The tenant's business name for the email greeting; null when unset. */
export async function resolveTenantBusinessName(
  settingsRepo: SettingsRepository,
  tenantId: string,
): Promise<string | null> {
  const settings = await settingsRepo.findByTenant(tenantId);
  return settings?.businessName ?? null;
}
