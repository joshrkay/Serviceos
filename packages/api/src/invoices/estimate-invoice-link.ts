import type { Estimate, EstimateRepository } from '../estimates/estimate';
import type { Invoice, InvoiceRepository } from './invoice';
import { resolveSelectedLineItems } from '../shared/billing-engine';

/**
 * #1490 — an estimate bills through at most ONE invoice (uq_invoices_estimate).
 * The invoice already holding that link, if any, with the estimate it bills.
 * Used to refuse a second invoice-from-estimate before its insert collides —
 * at approval (executabilityGaps) and at execution (draft_invoice handler).
 */
export async function findInvoiceHoldingEstimate(
  tenantId: string,
  estimateId: string,
  deps: {
    estimateRepo: Pick<EstimateRepository, 'findById'>;
    invoiceRepo: Pick<InvoiceRepository, 'findByJob'>;
  },
): Promise<{ estimate: Estimate; invoice: Invoice } | null> {
  const estimate = await deps.estimateRepo.findById(tenantId, estimateId);
  if (!estimate) return null;
  const invoice = (await deps.invoiceRepo.findByJob(tenantId, estimate.jobId)).find(
    (inv) => inv.estimateId === estimateId,
  );
  return invoice ? { estimate, invoice } : null;
}

/** The operator-facing refusal for a second invoice from an already-invoiced estimate. */
export function estimateAlreadyInvoicedReason(estimate: Estimate, invoice: Invoice): string {
  return (
    `Estimate ${estimate.estimateNumber} is already invoiced as ${invoice.invoiceNumber} — ` +
    `open that invoice instead of drafting a second one`
  );
}

/**
 * #1276F / #1405 — bill THIS estimate: its customer-selected lines, its
 * discount and its tax rate replace whatever the draft carried, verbatim —
 * the same selection REST convert-to-invoice bills. Used when the invoice
 * handler drafts from a known estimate, when the operator picks one of
 * several, and (#1480) when a chained invoice executes after the estimate
 * step that produced its estimate.
 */
export function copyEstimateOntoInvoicePayload(
  payload: Record<string, unknown>,
  estimate: Estimate,
): void {
  payload.lineItems = resolveSelectedLineItems(estimate.lineItems, estimate.acceptedSelection).map(
    (li) => ({ ...li }),
  );
  payload.estimateId = estimate.id;
  if (!payload.jobId) payload.jobId = estimate.jobId;
  payload.discountCents = estimate.totals.discountCents;
  payload.taxRateBps = estimate.totals.taxRateBps;
  delete payload.estimateReference;
}
