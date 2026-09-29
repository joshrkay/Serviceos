import type { Estimate, EstimateRepository } from '../estimates/estimate';
import type { Invoice, InvoiceRepository } from './invoice';

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
