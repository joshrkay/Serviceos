/**
 * P9-003 — Recurring service-agreements sweeper.
 *
 * Mirrors the execution-worker (P0-009) pattern: a cross-tenant sweep that
 * iterates active tenants, calls `runDueAgreements(tenantId, ...)` for each,
 * and never lets a single tenant's failure crash the loop.
 *
 * The sweep cadence is owned by `app.ts` (a setInterval driver). Tests
 * exercise this function directly with mocked deps.
 */
import { Logger } from '../logging/logger';
import {
  runDueAgreements,
  renewExpiringAgreements,
  RunDueDeps,
  RunDueResult,
  JobsServicePort,
  InvoicesServicePort,
} from '../agreements/agreement-service';
import { AgreementRepository } from '../agreements/agreement';
import { AgreementRunRepository } from '../agreements/agreement-run';
import { AuditRepository } from '../audit/audit';

export interface RecurringAgreementsWorkerDeps {
  agreementRepo: AgreementRepository;
  runRepo: AgreementRunRepository;
  jobsService: JobsServicePort;
  invoicesService: InvoicesServicePort;
  /** Returns the list of tenant IDs we should sweep. */
  listTenantIds: () => Promise<string[]>;
  auditRepo?: AuditRepository;
  logger: Logger;
}

export async function runRecurringAgreementsSweep(
  deps: RecurringAgreementsWorkerDeps,
): Promise<{ tenants: number; renewed: number; generated: number; skipped: number; failed: number }> {
  let tenantIds: string[];
  try {
    tenantIds = await deps.listTenantIds();
  } catch (err) {
    deps.logger.error('Recurring-agreements sweep: failed to list tenants', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { tenants: 0, renewed: 0, generated: 0, skipped: 0, failed: 0 };
  }

  let renewed = 0;
  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    // Renew lapsed memberships first so a just-renewed agreement that is also
    // due fires in the same sweep. Isolated try: a renewal failure must not
    // block this tenant's run sweep.
    try {
      const renewResult = await renewExpiringAgreements(tenantId, {
        agreementRepo: deps.agreementRepo,
        auditRepo: deps.auditRepo,
      });
      renewed += renewResult.renewedAgreementIds.length;
      if (renewResult.renewedAgreementIds.length > 0) {
        deps.logger.info('Recurring-agreements sweep: memberships renewed', {
          tenantId,
          renewed: renewResult.renewedAgreementIds.length,
        });
      }
    } catch (err) {
      deps.logger.warn('Recurring-agreements sweep: renewal failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const result: RunDueResult = await runDueAgreements(tenantId, {
        agreementRepo: deps.agreementRepo,
        runRepo: deps.runRepo,
        jobsService: deps.jobsService,
        invoicesService: deps.invoicesService,
        auditRepo: deps.auditRepo,
      } satisfies RunDueDeps);
      generated += result.generatedRunIds.length;
      skipped += result.skippedRunIds.length;
      failed += result.failedRunIds.length;
      if (
        result.generatedRunIds.length > 0 ||
        result.failedRunIds.length > 0
      ) {
        deps.logger.info('Recurring-agreements sweep: tenant processed', {
          tenantId,
          generated: result.generatedRunIds.length,
          skipped: result.skippedRunIds.length,
          failed: result.failedRunIds.length,
        });
      }
    } catch (err) {
      // Mirror execution-worker.ts: a single tenant's failure is logged
      // and swallowed so the sweep keeps going.
      deps.logger.warn('Recurring-agreements sweep: tenant failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { tenants: tenantIds.length, renewed, generated, skipped, failed };
}
