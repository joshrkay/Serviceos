/**
 * D-044 / #1770 — the connected-domain verification sweep: a leader-gated
 * P0-009 sweep, driven from app.ts every minute behind its own advisory lock.
 *
 * It lists the claims whose next check is due (waiting on the owner's CNAME or
 * on the certificate) and gives each one `checkCustomDomain` step. Backoff is
 * stored per claim (`custom_domain_next_check_at`, 1m doubling to 1h, given up
 * after CUSTOM_DOMAIN_MAX_ATTEMPTS), so a tick only touches what is due. One
 * claim's failure is logged and counted; the pass goes on. A failing listing
 * fails the pass, so the leader tick records no heartbeat and the missed sweep
 * shows as lag.
 */
import type { Logger } from '../logging/logger';
import { checkCustomDomain } from '../tenant-site/custom-domain';
import type { CustomDomainCheckDeps } from '../tenant-site/custom-domain';

export const CUSTOM_DOMAIN_SWEEP_INTERVAL_MS = 60_000;
/** Claims checked per tick; the rest wait for the next one. */
export const CUSTOM_DOMAIN_SWEEP_BATCH = 25;

export interface CustomDomainSweepDeps extends CustomDomainCheckDeps {
  logger: Pick<Logger, 'error'>;
  limit?: number;
}

export interface CustomDomainSweepResult {
  due: number;
  verified: number;
  failed: number;
}

export async function runCustomDomainSweep(deps: CustomDomainSweepDeps): Promise<CustomDomainSweepResult> {
  const at = (deps.now ?? (() => new Date()))();
  const due = await deps.siteRepo.listDueCustomDomains(at, deps.limit ?? CUSTOM_DOMAIN_SWEEP_BATCH);
  const result: CustomDomainSweepResult = { due: due.length, verified: 0, failed: 0 };
  for (const site of due) {
    try {
      const updated = await checkCustomDomain(deps, site);
      if (updated?.customDomain?.status === 'verified') result.verified++;
    } catch (err) {
      result.failed++;
      deps.logger.error('Custom-domain sweep: claim failed; continuing', {
        tenantId: site.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
