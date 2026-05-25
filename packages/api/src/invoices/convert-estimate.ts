import {
  Invoice,
  InvoiceRepository,
  createInvoiceWithNextNumber,
} from './invoice';
import { applyDepositCreditToInvoice } from './deposit-credit';
import { PaymentRepository } from './payment';
import { EstimateRepository } from '../estimates/estimate';
import { JobRepository, Job } from '../jobs/job';
import { SettingsRepository } from '../settings/settings';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { ConflictError, ValidationError } from '../shared/errors';
import { resolveSelectedLineItems } from '../shared/billing-engine';
import { RefreshJobMoneyStateDeps, refreshJobMoneyStateSafe } from '../jobs/job-money-state';
import { Logger } from '../logging/logger';

export interface ConvertEstimateDeps {
  estimateRepo: EstimateRepository;
  invoiceRepo: InvoiceRepository;
  jobRepo: JobRepository;
  settingsRepo: SettingsRepository;
  auditRepo: AuditRepository;
  /** When wired, a paid deposit on the job is credited to the new invoice. */
  paymentRepo?: PaymentRepository;
  /** When wired, the job's money state is rolled up after conversion. */
  moneyStateDeps?: RefreshJobMoneyStateDeps;
  actorId: string;
  logger?: Logger;
}

/**
 * Convert an ACCEPTED estimate into a draft invoice.
 *
 * Idempotent: if an invoice already links to this estimate, that invoice
 * is returned unchanged (the DB partial-unique index on
 * invoices.estimate_id is the race backstop). Bills exactly the line
 * items the customer agreed to — the good-better-best selection locked in
 * `estimate.acceptedSelection` — recomputing totals from those items
 * rather than trusting the estimate's stored totals. Any paid deposit on
 * the linked job is credited onto the new invoice. Emits
 * `estimate.converted` and rolls up the job money state.
 *
 * Returns null when the estimate doesn't exist.
 */
export async function convertEstimateToInvoice(
  tenantId: string,
  estimateId: string,
  deps: ConvertEstimateDeps,
): Promise<Invoice | null> {
  const estimate = await deps.estimateRepo.findById(tenantId, estimateId);
  if (!estimate) return null;

  if (estimate.status !== 'accepted') {
    throw new ValidationError(
      `Only an accepted estimate can be converted to an invoice (current status: '${estimate.status}').`,
    );
  }

  // Idempotency: an estimate converts to at most one invoice. Return the
  // existing one rather than minting a second invoice number.
  const existing = await deps.invoiceRepo.findByJob(tenantId, estimate.jobId);
  const alreadyConverted = existing.find((inv) => inv.estimateId === estimate.id);
  if (alreadyConverted) return alreadyConverted;

  // Bill only the items the customer selected (tiers + add-ons), falling
  // back to defaults when no selection was captured.
  const billedItems = resolveSelectedLineItems(estimate.lineItems, estimate.acceptedSelection);
  if (billedItems.length === 0) {
    throw new ConflictError('Estimate has no billable line items to convert.');
  }

  const job = (await deps.jobRepo.findById(tenantId, estimate.jobId)) as Job | null;

  const invoice = await createInvoiceWithNextNumber(
    {
      tenantId,
      jobId: estimate.jobId,
      estimateId: estimate.id,
      lineItems: billedItems,
      discountCents: estimate.totals.discountCents,
      taxRateBps: estimate.totals.taxRateBps,
      customerMessage: estimate.customerMessage,
      originatingLeadId: job?.originatingLeadId,
      createdBy: deps.actorId,
    },
    deps.invoiceRepo,
    deps.settingsRepo,
    deps.auditRepo,
  );

  let result = invoice;
  if (deps.paymentRepo && job) {
    try {
      const credit = await applyDepositCreditToInvoice(
        invoice,
        job,
        deps.invoiceRepo,
        deps.paymentRepo,
        deps.jobRepo,
      );
      if (credit) result = credit.invoice;
    } catch (creditErr) {
      // Best-effort: the invoice exists with the correct total; an
      // uncredited deposit stays on the job for manual reconciliation.
      deps.logger?.warn('estimate convert: deposit credit failed', {
        estimateId: estimate.id,
        invoiceId: invoice.id,
        error: creditErr instanceof Error ? creditErr.message : String(creditErr),
      });
    }
  }

  await deps.auditRepo.create(
    createAuditEvent({
      tenantId,
      actorId: deps.actorId,
      actorRole: 'unknown',
      eventType: 'estimate.converted',
      entityType: 'estimate',
      entityId: estimate.id,
      metadata: {
        estimateNumber: estimate.estimateNumber,
        invoiceId: result.id,
        invoiceNumber: result.invoiceNumber,
        totalCents: result.totals.totalCents,
      },
    }),
  );

  if (deps.moneyStateDeps) {
    await refreshJobMoneyStateSafe(tenantId, estimate.jobId, deps.actorId, deps.moneyStateDeps);
  }

  return result;
}
