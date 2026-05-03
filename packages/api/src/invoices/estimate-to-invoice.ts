/**
 * Estimate → Invoice conversion.
 *
 * Closes a critical gap in the lead-to-cash chain: when a customer
 * accepts an estimate (sets `acceptedAt`), they currently fall off a
 * cliff — the operator has to manually re-key every line item into a
 * new invoice. This service copies the estimate verbatim into a draft
 * invoice with `estimateId` populated for traceability, then emits an
 * audit event that ties the two together.
 *
 * Idempotency: the destination invoice carries `estimate_id` (already
 * a column on invoices). If an invoice already exists for this
 * estimate, this function returns it without creating a duplicate.
 *
 * Originating-lead attribution propagates through the job — we do NOT
 * thread it directly from the estimate, because a job is the canonical
 * point of source attribution and an estimate without a job shouldn't
 * exist in this codebase.
 */
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { ValidationError } from '../shared/errors';
import { EstimateRepository } from '../estimates/estimate';
import { JobRepository } from '../jobs/job';
import { SettingsRepository } from '../settings/settings';
import { Invoice, InvoiceRepository, createInvoiceWithNextNumber } from './invoice';

export interface ConvertEstimateToInvoiceInput {
  tenantId: string;
  estimateId: string;
  createdBy: string;
}

/**
 * Returns the existing invoice if one was already converted from this
 * estimate (idempotent). Otherwise creates a draft invoice with line
 * items, totals, and customer message copied from the estimate.
 *
 * Throws ValidationError when:
 *   - the estimate doesn't exist or belongs to a different tenant
 *   - the estimate is not in the `accepted` state
 */
export async function convertEstimateToInvoice(
  input: ConvertEstimateToInvoiceInput,
  estimateRepo: EstimateRepository,
  jobRepo: JobRepository,
  invoiceRepo: InvoiceRepository,
  settingsRepo: SettingsRepository,
  auditRepo?: AuditRepository,
): Promise<Invoice> {
  const estimate = await estimateRepo.findById(input.tenantId, input.estimateId);
  if (!estimate) {
    throw new ValidationError('Estimate not found');
  }
  if (estimate.status !== 'accepted') {
    throw new ValidationError(
      `Estimate must be accepted before conversion (current status: ${estimate.status})`
    );
  }

  // Idempotency: a single-pass scan of invoices for this job — fine
  // for the cardinality (a job rarely has more than a handful).
  const existingForJob = await invoiceRepo.findByJob(input.tenantId, estimate.jobId);
  const alreadyConverted = existingForJob.find((i) => i.estimateId === estimate.id);
  if (alreadyConverted) {
    return alreadyConverted;
  }

  // Inherit originating_lead_id from the parent job (the same path
  // POST /api/invoices uses) so attribution survives the conversion.
  const job = await jobRepo.findById(input.tenantId, estimate.jobId);

  const invoice = await createInvoiceWithNextNumber(
    {
      tenantId: input.tenantId,
      jobId: estimate.jobId,
      estimateId: estimate.id,
      lineItems: estimate.lineItems,
      discountCents: estimate.totals.discountCents,
      taxRateBps: estimate.totals.taxRateBps,
      customerMessage: estimate.customerMessage,
      originatingLeadId: job?.originatingLeadId,
      createdBy: input.createdBy,
    },
    invoiceRepo,
    settingsRepo,
    auditRepo,
  );

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.createdBy,
        actorRole: 'unknown',
        eventType: 'invoice.created_from_estimate',
        entityType: 'invoice',
        entityId: invoice.id,
        metadata: {
          estimateId: estimate.id,
          estimateNumber: estimate.estimateNumber,
          jobId: estimate.jobId,
        },
      })
    );
  }

  return invoice;
}
