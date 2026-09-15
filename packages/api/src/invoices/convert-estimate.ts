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
import { withRequestSavepoint } from '../middleware/tenant-context';
import { InvoiceScheduleRepository } from './invoice-schedule';
import {
  estimateLinkHeldByMilestoneReason,
  invoiceStillBills,
  wholeInvoiceBlockedByPlan,
} from './milestone-billing-guard';

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
  /**
   * #1203 — when wired, an estimate billed by a milestone plan is not
   * converted into a second, whole-estimate invoice.
   */
  scheduleRepo?: InvoiceScheduleRepository;
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
 * #1203 — refused (409) while a milestone plan bills the estimate (the plan
 * has minted a milestone that still bills, or completion will still mint it),
 * and when the estimate's single link is held by one of the plan's milestone
 * invoices that no longer bills. A plan that recorded no estimate counts as
 * billing the job's single accepted estimate. Never returns a milestone
 * invoice, or an invoice that no longer bills, as "the" conversion.
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
  // A milestone plan's first invoice also carries the estimate id; it is not
  // a conversion (#1203), so only a non-milestone invoice short-circuits.
  const existing = await deps.invoiceRepo.findByJob(tenantId, estimate.jobId);
  const alreadyConverted = existing.find(
    (inv) => inv.estimateId === estimate.id && inv.scheduleId === undefined,
  );
  if (alreadyConverted) return alreadyConverted;

  // Bill only the items the customer selected (tiers + add-ons), falling
  // back to defaults when no selection was captured.
  const billedItems = resolveSelectedLineItems(estimate.lineItems, estimate.acceptedSelection);
  if (billedItems.length === 0) {
    throw new ConflictError('Estimate has no billable line items to convert.');
  }

  const job = (await deps.jobRepo.findById(tenantId, estimate.jobId)) as Job | null;

  // #1203 — plan then convert: never a second, whole-estimate invoice, and
  // never an insert that can only collide with a plan milestone's link.
  if (deps.scheduleRepo) {
    const refusal = await wholeInvoiceBlockedByPlan(
      {
        scheduleRepo: deps.scheduleRepo,
        invoiceRepo: deps.invoiceRepo,
        settingsRepo: deps.settingsRepo,
        estimateRepo: deps.estimateRepo,
      },
      { tenantId, jobId: estimate.jobId, jobStatus: job?.status, estimateId: estimate.id, invoices: existing },
    );
    if (refusal) throw new ConflictError(refusal);
  }

  let invoice;
  try {
    // #1203 — SAVEPOINT-wrap the insert: on the request path (POST
    // /estimates/:id/convert-to-invoice) a 23505 would otherwise abort the
    // whole request transaction, so the re-fetch below could never run and the
    // caller got a 500. No-op off the request path.
    invoice = await withRequestSavepoint(() => createInvoiceWithNextNumber(
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
    ));
  } catch (err) {
    // Concurrency backstop: a racing convert may have inserted the linked
    // invoice between our findByJob check and this insert, tripping the
    // uq_invoices_estimate unique index (Postgres 23505). Re-fetch and
    // return the winner's invoice so both callers get a consistent result.
    // #1203 — only a real conversion that still bills is "the winner". The
    // link can also be held by a milestone invoice, or by one that no longer
    // bills; returning that as "Invoice created" would bill nothing.
    const code = (err as { code?: string } | undefined)?.code;
    if (code === '23505') {
      const holders = (await deps.invoiceRepo.findByJob(tenantId, estimate.jobId)).filter(
        (inv) => inv.estimateId === estimate.id,
      );
      const raced = holders.find((inv) => inv.scheduleId === undefined && invoiceStillBills(inv));
      if (raced) return raced;
      const holder = holders[0];
      if (holder) {
        throw new ConflictError(
          holder.scheduleId !== undefined
            ? estimateLinkHeldByMilestoneReason(holder)
            : `This estimate is linked to ${holder.invoiceNumber}, which is ${holder.status}, so no new invoice ` +
              'can be linked to it and none was created. Invoice it by hand (without choosing the estimate).',
        );
      }
    }
    throw err;
  }

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
