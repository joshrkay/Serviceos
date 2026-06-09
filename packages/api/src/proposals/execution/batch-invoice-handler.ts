import { v4 as uuidv4 } from 'uuid';
import {
  Proposal,
  ProposalType,
  ProposalRepository,
  createProposal,
} from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { ConflictError } from '../../shared/errors';

interface BatchJob {
  jobId: string;
  customerId: string;
  estimateId?: string;
  discountCents?: number;
  taxRateBps?: number;
  lineItems: Array<Record<string, unknown>>;
}

/**
 * P21-003 — Deterministic execution for batch_invoice proposals.
 *
 * On approval, fans out one `draft_invoice` proposal per candidate job (each
 * separately reviewed before sending). The per-job line items were resolved at
 * sweep time and carried in the payload; here we add a `unitPrice` alias so
 * each draft_invoice payload also satisfies that contract's lineItem shape
 * (the execution handler reads `unitPriceCents`).
 *
 * Capture-class — no money moves, nothing is sent. Idempotent on
 * `resultEntityId` (a re-execution does not re-fan-out). Degrades to a
 * synthetic-id passthrough when the proposal repo is absent (in-memory tests).
 */
export class BatchInvoiceExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'batch_invoice';

  constructor(private readonly proposalRepo?: ProposalRepository) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const jobs = proposal.payload.jobs as BatchJob[] | undefined;
    if (!Array.isArray(jobs) || jobs.length === 0) {
      return { success: false, error: 'Payload must include at least one job' };
    }

    if (proposal.resultEntityId) {
      return { success: true, resultEntityId: proposal.resultEntityId };
    }

    if (!this.proposalRepo) {
      return { success: true, resultEntityId: uuidv4() };
    }

    try {
      const createdIds: string[] = [];
      for (const job of jobs) {
        const lineItems = (job.lineItems ?? []).map((li) => ({
          ...li,
          unitPrice: (li as { unitPriceCents?: number }).unitPriceCents,
        }));
        const draft = createProposal({
          tenantId: context.tenantId,
          proposalType: 'draft_invoice',
          payload: {
            customerId: job.customerId,
            jobId: job.jobId,
            ...(job.estimateId ? { estimateId: job.estimateId } : {}),
            lineItems,
            // Preserve the accepted estimate's discount + tax so the draft bills
            // the accepted amount (the handler recomputes totals from these).
            ...(typeof job.discountCents === 'number' ? { discountCents: job.discountCents } : {}),
            ...(typeof job.taxRateBps === 'number' ? { taxRateBps: job.taxRateBps } : {}),
          },
          summary: 'Draft invoice (batch)',
          explanation: 'Generated from an approved batch-invoice proposal. Approve to create the invoice.',
          sourceContext: { source: 'batch_invoice', batchProposalId: proposal.id },
          targetEntityType: 'job',
          targetEntityId: job.jobId,
          idempotencyKey: `batch_invoice:${proposal.id}:${job.jobId}`,
          createdBy: context.executedBy,
        });
        try {
          const persisted = await this.proposalRepo.create(draft);
          createdIds.push(persisted.id);
        } catch (err) {
          // Resumability: this proposal's resultEntityId is only set on full
          // success, so a transient failure partway through the fan-out leaves
          // the batch retryable. On retry the loop restarts at job 0, whose
          // per-job idempotencyKey already exists — a ConflictError here means
          // that draft was already created in the prior attempt, so skip it and
          // continue drafting the rest instead of wedging the whole batch.
          if (err instanceof ConflictError) continue;
          throw err;
        }
      }
      // The fan-out's "result" is the set of drafts; surface the first id.
      return { success: true, resultEntityId: createdIds[0] };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
