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
import { TenantTransactionRunner } from '../db/tenant-transaction';

const BATCH_ACTOR = 'system:batch_invoice';

export interface BatchInvoiceWorkerDeps extends InvoicingQueueDeps {
  proposalRepo: ProposalRepository;
  settingsRepo: SettingsRepository;
  runRepo: BatchInvoiceRunRepository;
  /**
   * Wraps each tenant's dedup-row reservations + the batch_invoice proposal
   * write in ONE transaction, so a proposal failure rolls the reservations back
   * with it (no orphaned rows) and the jobs stay eligible for the next sweep.
   * Each reservation runs in a SAVEPOINT so an already-batched row (23505)
   * rolls back just that insert and the sweep continues.
   */
  txRunner: TenantTransactionRunner;
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

      // Reserve a dedup row per candidate AND create the batch proposal inside
      // ONE transaction. The ledger's UNIQUE (tenant, job, batch_date) is the
      // atomic dedup guard, so a job already batched today (re-run or a race)
      // raises 23505 — caught inside a per-candidate SAVEPOINT that rolls back
      // just that insert and leaves the transaction usable, so the sweep keeps
      // going. Atomicity is the correctness fix: if the proposal write fails the
      // reservations roll back with it, so we never persist a proposal whose
      // jobs lack dedup rows (the next same-day sweep would re-batch them into a
      // SECOND proposal, double-invoicing on dual approval) and never leave rows
      // reserved for jobs that got no proposal (which would silently skip them
      // until the next day's batch_date).
      const outcome = await deps.txRunner.run(tenantId, async (scope) => {
        const reserved: InvoicingCandidate[] = [];
        let txSkipped = 0;
        for (const candidate of candidates) {
          try {
            await scope.savepoint(() =>
              deps.runRepo.create(buildBatchInvoiceRun(tenantId, candidate.jobId, batchDate)),
            );
            reserved.push(candidate);
          } catch (err) {
            if (err && typeof err === 'object' && (err as { code?: string }).code === '23505') {
              txSkipped += 1; // already batched today
              continue;
            }
            throw err; // real error — roll the whole tenant back; no proposal.
          }
        }
        if (reserved.length === 0) {
          return { proposalId: undefined, jobCount: 0, totalCents: 0, txSkipped };
        }

        const totalCents = reserved.reduce((sum, c) => sum + c.amountCents, 0);
        const proposal = createProposal({
          tenantId,
          proposalType: 'batch_invoice',
          payload: {
            batchDate,
            totalCents,
            jobs: reserved.map((c) => ({
              jobId: c.jobId,
              customerId: c.customerId,
              ...(c.estimateId ? { estimateId: c.estimateId } : {}),
              amountCents: c.amountCents,
              discountCents: c.discountCents,
              taxRateBps: c.taxRateBps,
              lineItems: c.lineItems,
            })),
          },
          summary: `${reserved.length} job${reserved.length === 1 ? '' : 's'} ready to invoice ($${(totalCents / 100).toFixed(2)})`,
          explanation: 'Approve to draft an invoice for each job; you review each before sending.',
          createdBy: BATCH_ACTOR,
        });
        await deps.proposalRepo.create(proposal);
        return { proposalId: proposal.id, jobCount: reserved.length, totalCents, txSkipped };
      });

      skipped += outcome.txSkipped;
      if (!outcome.proposalId) continue;
      proposals += 1;
      jobsBatched += outcome.jobCount;

      // Audit is emitted after the proposal commits (best-effort, as before):
      // it records the now-durable batch and must not roll the proposal back.
      if (deps.auditRepo) {
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: BATCH_ACTOR,
            actorRole: 'system',
            eventType: 'invoice.batch_proposed',
            entityType: 'proposal',
            entityId: outcome.proposalId,
            metadata: { batchDate, jobCount: outcome.jobCount, totalCents: outcome.totalCents },
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
