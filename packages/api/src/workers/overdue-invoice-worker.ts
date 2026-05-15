/**
 * §6 Time-to-Cash — overdue-invoice sweeper.
 *
 * Mirrors the P0-009 execution-worker pattern: a cross-tenant sweep that
 * never lets one tenant's failure crash the loop, with per-tenant
 * try/catch and a `failed` counter for observability (the same shape as
 * `execution-worker.ts`; `recurring-agreements-worker.ts` uses a similar
 * structure but only logs on failure without counting).
 * For each tenant it finds unpaid invoices past their due date, refreshes
 * the linked job's money-state (which flips it to `overdue`), and emits an
 * `invoice.overdue` audit event the first time a job crosses into the
 * overdue state — §7's dunning layer listens for that event.
 *
 * The sweep cadence is owned by app.ts (a setInterval driver). Tests
 * exercise this function directly with in-memory repos and a fixed clock.
 */
import { Logger } from '../logging/logger';
import { JobRepository } from '../jobs/job';
import { EstimateRepository } from '../estimates/estimate';
import { InvoiceRepository } from '../invoices/invoice';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { refreshJobMoneyStateSafe } from '../jobs/job-money-state';

export interface OverdueInvoiceWorkerDeps {
  jobRepo: JobRepository;
  estimateRepo: EstimateRepository;
  invoiceRepo: InvoiceRepository;
  auditRepo: AuditRepository;
  /** Returns the list of tenant IDs to sweep. */
  listTenantIds: () => Promise<string[]>;
  logger: Logger;
  /** Injectable clock — defaults to `() => new Date()`. */
  now?: () => Date;
}

export async function runOverdueInvoiceSweep(
  deps: OverdueInvoiceWorkerDeps,
): Promise<{ tenants: number; overdue: number; failed: number }> {
  const now = deps.now ?? (() => new Date());

  let tenantIds: string[];
  try {
    tenantIds = await deps.listTenantIds();
  } catch (err) {
    deps.logger.error('Overdue-invoice sweep: failed to list tenants', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { tenants: 0, overdue: 0, failed: 0 };
  }

  const asOf = now(); // One snapshot for the entire sweep.
  let overdue = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    try {
      // Prefilter: unpaid invoices whose due date has passed. The
      // authoritative overdue decision is made by computeJobMoneyState
      // inside refreshJobMoneyState — this query just narrows the set.
      const candidates = [
        ...(await deps.invoiceRepo.findByTenant(tenantId, {
          status: 'open',
          toDueDate: asOf,
        })),
        ...(await deps.invoiceRepo.findByTenant(tenantId, {
          status: 'partially_paid',
          toDueDate: asOf,
        })),
      ];

      for (const invoice of candidates) {
        const result = await refreshJobMoneyStateSafe(
          tenantId,
          invoice.jobId,
          'overdue-invoice-worker',
          {
            jobRepo: deps.jobRepo,
            estimateRepo: deps.estimateRepo,
            invoiceRepo: deps.invoiceRepo,
            auditRepo: deps.auditRepo,
            now: deps.now,
          },
          deps.logger,
        );

        // Emit invoice.overdue only on the transition INTO overdue, so a
        // re-run of the sweep doesn't re-fire the event: once the job is
        // `overdue`, refreshJobMoneyState reports changed:false.
        if (result.changed && result.current === 'overdue') {
          overdue++;
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: 'overdue-invoice-worker',
              actorRole: 'system',
              eventType: 'invoice.overdue',
              entityType: 'invoice',
              entityId: invoice.id,
              metadata: {
                jobId: invoice.jobId,
                dueDate: invoice.dueDate?.toISOString(),
                amountDueCents: invoice.amountDueCents,
              },
            }),
          );
        }
      }
    } catch (err) {
      // Mirror execution-worker.ts: one tenant's failure is logged and
      // swallowed so the sweep keeps going.
      failed++;
      deps.logger.warn('Overdue-invoice sweep: tenant failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  deps.logger.info('Overdue-invoice sweep completed', {
    tenants: tenantIds.length,
    overdue,
    failed,
  });

  return { tenants: tenantIds.length, overdue, failed };
}
