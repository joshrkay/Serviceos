import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { Invoice, InvoiceRepository } from '../../invoices/invoice';
import {
  buildLineItem,
  calculateDocumentTotals,
} from '../../shared/billing-engine';
import {
  RefreshJobMoneyStateDeps,
  refreshJobMoneyStateSafe,
} from '../../jobs/job-money-state';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { applyLateFeePayloadSchema } from '../contracts/apply-late-fee';
import { v5 as uuidv5 } from 'uuid';

/**
 * Fixed namespace so a late-fee line's id is a DETERMINISTIC, valid UUID
 * derived from the accrual step. It must be a real UUID — not the human-
 * readable `late-fee:<stepKey>` — because the invoice repo replaces any
 * non-UUID line-item id with a random one on insert (pg-invoice
 * insertLineItems), which silently defeated the idempotency guard on reload
 * and allowed a retried proposal to append a SECOND late-fee line.
 */
const LATE_FEE_ID_NAMESPACE = 'b6c9e0a2-5f3d-4b1e-9c8a-1d2e3f4a5b6c';

/**
 * Deterministic, persistence-stable id for the late-fee line of `stepKey` on a
 * SPECIFIC invoice. `invoice_line_items.id` is a global primary key and the
 * dunning worker uses the same step (e.g. 'initial') for every invoice, so the
 * id MUST include the invoice id — otherwise the second invoice's 'initial'
 * fee would collide on the same UUID and the insert would fail with a
 * duplicate key instead of applying the fee. Keying on (invoiceId, stepKey)
 * keeps idempotency per-invoice while staying globally unique.
 */
export function lateFeeLineId(invoiceId: string, stepKey: string): string {
  return uuidv5(`${invoiceId}:late-fee:${stepKey}`, LATE_FEE_ID_NAMESPACE);
}

/**
 * Executes an approved `apply_late_fee` proposal (collections cadence).
 *
 * Appends the already-computed late fee as a NON-TAXABLE line item to an
 * overdue invoice, recomputes the document totals through the shared billing
 * engine (so the cent-rounding convention can't drift from tax/discount
 * math), and refreshes the job money-state rollup. The fee amount is integer
 * cents end-to-end — no float ever enters this path.
 *
 * Money-class: this only ever runs after explicit owner approval (money
 * proposals never auto-approve). Guards:
 * - Idempotent: the fee line carries a deterministic UUID derived from
 *   `late-fee:<stepKey>` (see lateFeeLineId), so re-executing the same
 *   proposal — or a duplicate — is a no-op success rather than a double
 *   charge, even after the invoice is reloaded from the DB.
 * - Only applies to invoices still owed (`open` / `partially_paid`). If the
 *   customer paid (or the invoice was voided) between proposal creation and
 *   approval, the fee is NOT applied and a clear failure is returned.
 *
 * Mirrors IssueInvoiceExecutionHandler: degrades to a synthetic-id
 * passthrough when no invoiceRepo is wired, returns failed ExecutionResults
 * (never throws through), and emits a failure-soft audit event.
 */
export class ApplyLateFeeExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'apply_late_fee';

  constructor(
    private readonly invoiceRepo?: InvoiceRepository,
    private readonly auditRepo?: AuditRepository,
    private readonly moneyStateDeps?: RefreshJobMoneyStateDeps,
  ) {}

  async execute(
    proposal: Proposal,
    context: ExecutionContext,
  ): Promise<ExecutionResult> {
    const parsed = applyLateFeePayloadSchema.safeParse(proposal.payload);
    if (!parsed.success) {
      return {
        success: false,
        error: 'Could not determine the late fee to apply (missing invoice or amount).',
      };
    }
    const { invoiceId, feeCents, stepKey } = parsed.data;

    if (!this.invoiceRepo) {
      // Dev wiring without a repo. Returns the invoice id.
      return { success: true, resultEntityId: invoiceId };
    }

    const invoice = await this.invoiceRepo.findById(context.tenantId, invoiceId);
    if (!invoice) {
      // Ambiguous on purpose — don't leak whether the invoice exists in
      // another tenant (RLS + tenant-scoped findById already isolate).
      return { success: false, error: `Invoice ${invoiceId} not found in this tenant` };
    }

    // Idempotency: a fee line for this accrual step already exists → no-op
    // success (re-execution or a duplicate proposal must not double-charge).
    // The id is a deterministic UUID so it survives the invoice repo's insert
    // (which rewrites non-UUID ids) and still matches on reload.
    const feeLineId = lateFeeLineId(invoice.id, stepKey);
    if (invoice.lineItems.some((li) => li.id === feeLineId)) {
      return { success: true, resultEntityId: invoice.id };
    }

    // Only apply to invoices that are still owed. A fee on a paid/void/draft
    // invoice is wrong — fail cleanly so the owner sees why nothing changed.
    if (invoice.status !== 'open' && invoice.status !== 'partially_paid') {
      return {
        success: false,
        error: `Invoice ${invoice.invoiceNumber} is '${invoice.status}', not overdue — late fee not applied.`,
      };
    }

    const feeLine = buildLineItem(
      feeLineId,
      'Late fee',
      1,
      feeCents,
      invoice.lineItems.length,
      false, // non-taxable: a late fee is not subject to sales tax
      'other',
    );
    const lineItems = [...invoice.lineItems, feeLine];
    const totals = calculateDocumentTotals(
      lineItems,
      invoice.totals.discountCents,
      invoice.totals.taxRateBps,
    );
    const amountDueCents = Math.max(0, totals.totalCents - invoice.amountPaidCents);

    let updated: Invoice | null;
    try {
      updated = await this.invoiceRepo.update(context.tenantId, invoice.id, {
        lineItems,
        totals,
        amountDueCents,
        updatedAt: new Date(),
      });
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to apply late fee',
      };
    }
    if (!updated) {
      return { success: false, error: `Invoice ${invoiceId} not found in this tenant` };
    }

    // §6 Time-to-Cash. Best-effort job money-state rollup.
    if (this.moneyStateDeps) {
      await refreshJobMoneyStateSafe(
        context.tenantId,
        updated.jobId,
        'system',
        this.moneyStateDeps,
      );
    }

    // Audit emission is failure-soft: a logging failure never unwinds a
    // successful fee application.
    if (this.auditRepo) {
      try {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: 'system',
            eventType: 'invoice.late_fee_applied',
            entityType: 'invoice',
            entityId: updated.id,
            metadata: {
              proposalId: proposal.id,
              proposalType: 'apply_late_fee',
              stepKey,
              feeCents,
              newAmountDueCents: amountDueCents,
            },
          }),
        );
      } catch {
        // swallow — audit must never fail the execution
      }
    }

    return { success: true, resultEntityId: updated.id };
  }
}
