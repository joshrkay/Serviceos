/**
 * #1735 — drip campaign sweeper (P0-009 cross-tenant sweep pattern).
 *
 * app.ts drives `runDripCampaignSweep` on a 5-minute setInterval behind a
 * leader advisory lock (SWEEP_LOCK.dripCampaigns), like the digest and
 * reminder sweeps. Tenants without the `drip_campaigns` flag are skipped
 * entirely (off by default); one tenant's failure is logged and swallowed so
 * the loop keeps going. The engine does the per-step work and consent gating.
 */
import type { Logger } from '../logging/logger';
import type { DripEngine } from '../marketing/drip/drip-engine';

export const DRIP_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface DripSweepDeps {
  listTenantIds: () => Promise<string[]>;
  isEnabledForTenant: (tenantId: string) => Promise<boolean>;
  engine: Pick<DripEngine, 'runTenant'>;
  logger: Pick<Logger, 'info' | 'error'>;
}

export async function runDripCampaignSweep(deps: DripSweepDeps): Promise<{ tenants: number; processed: number }> {
  let tenants = 0;
  let processed = 0;
  for (const tenantId of await deps.listTenantIds()) {
    try {
      if (!(await deps.isEnabledForTenant(tenantId))) continue;
      tenants += 1;
      processed += await deps.engine.runTenant(tenantId);
    } catch (err) {
      deps.logger.error('Drip campaign sweep failed for tenant', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (processed > 0) deps.logger.info('Drip campaign sweep', { tenants, processed });
  return { tenants, processed };
}
