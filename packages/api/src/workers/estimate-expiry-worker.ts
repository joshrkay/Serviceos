/**
 * Estimate auto-expiry sweeper.
 *
 * Mirrors the cross-tenant sweep pattern from estimate-reminder-worker.ts:
 * a per-tenant try/catch so one tenant's failure never crashes the loop,
 * plus a per-estimate try/catch so one bad row doesn't skip the rest of
 * that tenant's estimates. For each tenant it finds estimates that are
 * still 'sent' but whose `valid_until` has passed, transitions them
 * sent -> expired, emits an audit event, and rolls up the linked job's
 * money state.
 *
 * Without this, a sent estimate sits in 'sent' forever even after its
 * validity date — the customer can still accept stale pricing and the
 * pipeline view never reflects that the quote lapsed.
 *
 * The sweep cadence is owned by app.ts (a setInterval driver). Tests
 * exercise this function directly with in-memory repos and a fixed clock.
 */
import { Logger } from '../logging/logger';
import { EstimateRepository, transitionEstimateStatus } from '../estimates/estimate';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { RefreshJobMoneyStateDeps } from '../jobs/job-money-state';

export interface EstimateExpiryWorkerDeps {
  estimateRepo: EstimateRepository;
  /** Returns the list of tenant IDs to sweep. */
  listTenantIds: () => Promise<string[]>;
  logger: Logger;
  /** Injectable clock — defaults to `() => new Date()`. */
  now?: () => Date;
  /** Optional audit trail of each expiry. */
  auditRepo?: AuditRepository;
  /** Optional money-state rollup deps, passed through to the transition. */
  moneyStateDeps?: RefreshJobMoneyStateDeps;
}

export async function runEstimateExpirySweep(
  deps: EstimateExpiryWorkerDeps,
): Promise<{ tenants: number; expired: number; failed: number }> {
  const now = deps.now ?? (() => new Date());

  let tenantIds: string[];
  try {
    tenantIds = await deps.listTenantIds();
  } catch (err) {
    deps.logger.error('Estimate-expiry sweep: failed to list tenants', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { tenants: 0, expired: 0, failed: 0 };
  }

  const asOf = now(); // One snapshot for the entire sweep.
  let expired = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    let candidates;
    try {
      candidates = await deps.estimateRepo.findByTenant(tenantId, { status: 'sent' });
    } catch (err) {
      failed++;
      deps.logger.warn('Estimate-expiry sweep: tenant failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const estimate of candidates) {
      // Only expire estimates that carry a validity date that has passed.
      if (!estimate.validUntil || estimate.validUntil.getTime() > asOf.getTime()) continue;

      try {
        await transitionEstimateStatus(
          tenantId,
          estimate.id,
          'expired',
          deps.estimateRepo,
          deps.moneyStateDeps,
        );
        expired++;
        if (deps.auditRepo) {
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: 'estimate-expiry-worker',
              actorRole: 'system',
              eventType: 'estimate.expired',
              entityType: 'estimate',
              entityId: estimate.id,
              metadata: {
                estimateNumber: estimate.estimateNumber,
                validUntil: estimate.validUntil.toISOString(),
              },
            }),
          );
        }
      } catch (err) {
        failed++;
        deps.logger.warn('Estimate-expiry sweep: estimate failed', {
          tenantId,
          estimateId: estimate.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  deps.logger.info('Estimate-expiry sweep completed', {
    tenants: tenantIds.length,
    expired,
    failed,
  });

  return { tenants: tenantIds.length, expired, failed };
}
