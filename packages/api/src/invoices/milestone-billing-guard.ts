/**
 * #1203 — never bill a job's estimate twice.
 *
 * The one check both milestone mint paths run before writing anything: the
 * create_invoice_schedule execution handler (before the schedule row and any
 * on_accept milestone) and the completion hook (before any on_completion
 * milestone). A milestone plan must not bill a job whose estimate is already
 * billed another way:
 *   - an invoice outside the plan already bills the estimate (typically the
 *     one POST /estimates/:id/convert-to-invoice wrote), see
 *     invoiceOutsideSchedule; or
 *   - the job's auto-drafted invoice (auto-invoice on completion) is still
 *     waiting for approval, so approving it would bill the whole estimate on
 *     top of the milestones.
 * No amount is computed here; a conflict only stops the mint.
 */
import type { Invoice } from './invoice';
import type { ProposalRepository } from '../proposals/proposal';
import { estimateAlreadyInvoicedReason, invoiceOutsideSchedule } from './invoice-schedule';
import { findWaitingAutoInvoiceProposal } from './auto-invoice-on-completion';

export interface MilestoneBillingConflict {
  /** Owner-facing sentence: why no milestone invoice was created. */
  reason: string;
  blockingInvoiceId?: string;
  blockingInvoiceNumber?: string;
  pendingProposalId?: string;
}

export const AUTO_INVOICE_WAITING_REASON =
  'An invoice for this job was auto-drafted when it was completed and is waiting for approval. ' +
  'No milestone invoices were created. Reject that draft first if the job should be billed in milestones.';

export async function findMilestoneBillingConflict(input: {
  tenantId: string;
  jobId: string;
  schedule: { id: string; estimateId?: string };
  jobInvoices: ReadonlyArray<Invoice>;
  /** Absent → the waiting auto-draft check is skipped (legacy wiring / unit fakes). */
  proposalRepo?: ProposalRepository;
}): Promise<MilestoneBillingConflict | null> {
  const blocking = invoiceOutsideSchedule(input.schedule, input.jobInvoices);
  if (blocking) {
    return {
      reason: estimateAlreadyInvoicedReason(blocking.invoiceNumber),
      blockingInvoiceId: blocking.id,
      blockingInvoiceNumber: blocking.invoiceNumber,
    };
  }
  if (input.proposalRepo) {
    const waiting = await findWaitingAutoInvoiceProposal(input.proposalRepo, input.tenantId, input.jobId);
    if (waiting) return { reason: AUTO_INVOICE_WAITING_REASON, pendingProposalId: waiting.id };
  }
  return null;
}
