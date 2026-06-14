/**
 * RV-065 — digest "invoice it" one-tap: mint a draft_invoice proposal for a
 * single completed-unbilled job.
 *
 * Eligibility + line items come from the SAME query the batch-invoice sweep
 * and the digest's unbilled section use (`findJobsRequiringInvoicing`), and
 * the proposal payload matches the shape the BatchInvoiceExecutionHandler
 * fans out (unitPrice alias + accepted estimate's discount/tax carried), so
 * the one-tap draft bills exactly what the batch path would have billed.
 *
 * Proposal-first by design: nothing is invoiced or sent here — the tap mints
 * a DRAFT proposal which then flows through the standard one-tap approve
 * page (capture-class draft_invoice; the executor creates the draft invoice
 * only after that explicit approval).
 */
import { ConflictError } from '../shared/errors';
import { createProposal, ProposalRepository } from '../proposals/proposal';
import {
  findJobsRequiringInvoicing,
  InvoicingQueueDeps,
} from '../invoices/invoicing-queue';
import { formatUsd } from './digest-service';

export interface MintDraftInvoiceDeps extends InvoicingQueueDeps {
  proposalRepo: ProposalRepository;
  /** Injectable clock — drives the per-day idempotency key. */
  now?: () => Date;
}

export type MintDraftInvoiceResult =
  | { ok: true; proposalId: string }
  /**
   * job_not_eligible: unknown / cross-tenant job id, job not completed, a
   * live invoice already exists, or nothing billable — all collapse into
   * one answer so the public route can't be used to probe job existence.
   * already_minted: a one-tap draft for this job was already created today.
   */
  | { ok: false; reason: 'job_not_eligible' | 'already_minted' };

export async function mintDraftInvoiceProposalForJob(
  tenantId: string,
  jobId: string,
  actorId: string,
  deps: MintDraftInvoiceDeps,
): Promise<MintDraftInvoiceResult> {
  const candidates = await findJobsRequiringInvoicing(tenantId, deps);
  const candidate = candidates.find((c) => c.jobId === jobId);
  if (!candidate) {
    return { ok: false, reason: 'job_not_eligible' };
  }

  // Same lineItem normalization the batch fan-out applies: the billing
  // engine emits unitPriceCents; the draft_invoice contract also accepts the
  // unitPrice alias, which the review UI reads.
  const lineItems = candidate.lineItems.map((li) => ({
    ...li,
    unitPrice: li.unitPriceCents,
  }));

  const utcDate = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);
  const proposal = createProposal({
    tenantId,
    proposalType: 'draft_invoice',
    payload: {
      customerId: candidate.customerId,
      jobId: candidate.jobId,
      ...(candidate.estimateId ? { estimateId: candidate.estimateId } : {}),
      lineItems,
      discountCents: candidate.discountCents,
      taxRateBps: candidate.taxRateBps,
    },
    summary: `Draft invoice (${formatUsd(candidate.amountCents)}) — digest one-tap`,
    explanation:
      'Created from the daily-digest "invoice it" link. Approve to create the draft invoice; you review it before sending.',
    sourceContext: { source: 'digest_one_tap' },
    targetEntityType: 'job',
    targetEntityId: candidate.jobId,
    // One one-tap draft per job per UTC day — a re-tap of a second digest
    // link (the nonce already blocks re-taps of the SAME link) dedupes here.
    idempotencyKey: `one_tap_invoice:${candidate.jobId}:${utcDate}`,
    createdBy: actorId,
  });

  try {
    const persisted = await deps.proposalRepo.create(proposal);
    return { ok: true, proposalId: persisted.id };
  } catch (err) {
    if (err instanceof ConflictError) {
      return { ok: false, reason: 'already_minted' };
    }
    throw err;
  }
}
