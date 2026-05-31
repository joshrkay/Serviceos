/**
 * P21-003 — Batch-invoice sweep.
 *
 * Clones the recurring-agreements sweep shape: a cross-tenant pass that, for
 * each opted-in tenant, finds jobs requiring invoicing and emits ONE
 * `batch_invoice` proposal summarizing them. `batch_invoice_runs` dedups per
 * (tenant, job, batch_date) — reserved before a job is included — so a re-run
 * on the same day never re-batches a job. A single tenant's failure is logged
 * and never crashes the loop.
 *
 * Proposal-first by design: nothing is invoiced or sent here. On approval the
 * BatchInvoiceExecutionHandler fans out N `draft_invoice` proposals.
 */
import { Logger } from '../logging/logger';
import { ProposalRepository, createProposal } from '../proposals/proposal';
import { SettingsRepository } from '../settings/settings';
import {
  findJobsRequiringInvoicing,
  InvoicingQueueDeps,
  InvoicingCandidate,
} from '../invoices/invoicing-queue';
import { BatchInvoiceRunRepository, buildBatchInvoiceRun } from '../invoices/batch-invoice-run';
import { AuditRepository, createAuditEvent } from '../audit/audit';

const BATCH_ACTOR = 'system:batch_invoice';

export interface BatchInvoiceWorkerDeps extends InvoicingQueueDeps {
  proposalRepo: ProposalRepository;
  settingsRepo: SettingsRepository;
  runRepo: BatchInvoiceRunRepository;
  listTenantIds: () => Promise<string[]>;
  auditRepo?: AuditRepository;
  logger: Logger;
  /** Override for tests; defaults to the current time. */
  now?: () => Date;
}

export interface BatchInvoiceSweepResult {
  tenants: number;
  proposals: number;
  jobs: number;
  skipped: number;
  failed: number;
}

function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function runBatchInvoiceSweep(
  deps: BatchInvoiceWorkerDeps,
): Promise<BatchInvoiceSweepResult> {
  const batchDate = utcDateString((deps.now ?? (() => new Date()))());

  let tenantIds: string[];
  try {
    tenantIds = await deps.listTenantIds();
  } catch (err) {
    deps.logger.error('Batch-invoice sweep: failed to list tenants', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { tenants: 0, proposals: 0, jobs: 0, skipped: 0, failed: 0 };
  }

  let proposals = 0;
  let jobsBatched = 0;
  let skipped = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    try {
      const settings = await deps.settingsRepo.findByTenant(tenantId);
      if (!settings?.batchInvoiceEnabled) continue; // opt-in only

      const candidates = await findJobsRequiringInvoicing(tenantId, deps);
      if (candidates.length === 0) continue;

      // Reserve a dedup row per job before including it; jobs already batched
      // today (23505) are skipped so a re-run doesn't double-draft.
      const fresh: InvoicingCandidate[] = [];
      for (const candidate of candidates) {
        try {
          await deps.runRepo.create(buildBatchInvoiceRun(tenantId, candidate.jobId, batchDate));
          fresh.push(candidate);
        } catch (err) {
          if ((err as { code?: string }).code === '23505') {
            skipped += 1;
            continue;
          }
          throw err;
        }
      }
      if (fresh.length === 0) continue;

      const totalCents = fresh.reduce((sum, c) => sum + c.amountCents, 0);
      const proposal = createProposal({
        tenantId,
        proposalType: 'batch_invoice',
        payload: {
          batchDate,
          totalCents,
          jobs: fresh.map((c) => ({
            jobId: c.jobId,
            customerId: c.customerId,
            ...(c.estimateId ? { estimateId: c.estimateId } : {}),
            amountCents: c.amountCents,
            lineItems: c.lineItems,
          })),
        },
        summary: `${fresh.length} job${fresh.length === 1 ? '' : 's'} ready to invoice ($${(totalCents / 100).toFixed(2)})`,
        explanation: 'Approve to draft an invoice for each job; you review each before sending.',
        createdBy: BATCH_ACTOR,
      });
      await deps.proposalRepo.create(proposal);
      proposals += 1;
      jobsBatched += fresh.length;

      if (deps.auditRepo) {
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: BATCH_ACTOR,
            actorRole: 'system',
            eventType: 'invoice.batch_proposed',
            entityType: 'proposal',
            entityId: proposal.id,
            metadata: { batchDate, jobCount: fresh.length, totalCents },
          }),
        );
      }
    } catch (err) {
      failed += 1;
      deps.logger.error('Batch-invoice sweep: tenant failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { tenants: tenantIds.length, proposals, jobs: jobsBatched, skipped, failed };
}
