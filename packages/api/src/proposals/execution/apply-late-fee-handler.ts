import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { Invoice, InvoiceRepository } from '../../invoices/invoice';
import { buildLineItem } from '../../shared/billing-engine';
import {
  RefreshJobMoneyStateDeps,
  refreshJobMoneyStateSafe,
} from '../../jobs/job-money-state';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { applyLateFeePayloadSchema } from '../contracts/apply-late-fee';
import type { PaymentLinkCleanupDeps } from '../../invoices/payment';
import {
  cancelInvoicePaymentIntents,
  deactivateInvoicePaymentLink,
} from '../../invoices/invoice-payment-link';
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
 * overdue invoice, moves the document totals by exactly the fee through the
 * shared billing engine's adjustment path (`applyNonTaxableAdjustment` — tax,
 * discount and processing fee stay as issued, so a discounted + taxed invoice
 * can still be fee'd instead of tripping the #1288 mixed-taxability
 * refusal), and refreshes the job money-state rollup. The fee amount is
 * integer cents end-to-end — no float ever enters this path.
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
 *
 * The append-line-and-adjust write itself is shared with
 * `ApplyCreditExecutionHandler`: both call
 * `InvoiceRepository.applyNonTaxableAdjustmentAtomic` (one guarded write
 * deriving amount due from the LIVE amount paid and re-checking status), then
 * run the same P0-9 stale link / PaymentIntent cleanup. Guards (idempotency,
 * status precondition, floor checks) and audit emission stay per-handler —
 * they differ enough that folding them in would obscure more than it'd save.
 */
export class ApplyLateFeeExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'apply_late_fee';

  constructor(
    private readonly invoiceRepo?: InvoiceRepository,
    private readonly auditRepo?: AuditRepository,
    private readonly moneyStateDeps?: RefreshJobMoneyStateDeps,
    /**
     * P0-9 — the fee re-prices the invoice, so a hosted payment link minted
     * at the pre-fee balance must die (a fresh one is minted on demand).
     */
    private readonly paymentLinkCleanup?: PaymentLinkCleanupDeps,
  ) {}

  // U8 — degrades to an echo passthrough (charges nothing) without the
  // invoice repo — see execute(). The boot guard (wiring-assertions.ts) fails
  // boot when a pool is configured but this is false, so a spoken late fee
  // can never report success while appending no fee line in production.
  isFullyWired(): boolean {
    return Boolean(this.invoiceRepo);
  }

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
    // #10 — one atomic write: the repo appends the fee line, moves the totals
    // by its amount (applyNonTaxableAdjustment semantics) and derives amount
    // due from the row's LIVE amount paid, so a webhook payment committing
    // after the read above is never overwritten by a snapshot figure.
    let updated: Invoice | null;
    try {
      updated = await this.invoiceRepo.applyNonTaxableAdjustmentAtomic(
        context.tenantId,
        invoice.id,
        feeLine,
        new Date(),
      );
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to apply late fee',
      };
    }
    if (!updated) {
      // The atomic write's live status guard refused it: the invoice was
      // paid / voided after the read above (or vanished). Nothing written.
      const live = await this.invoiceRepo.findById(context.tenantId, invoice.id);
      if (!live) {
        return { success: false, error: `Invoice ${invoiceId} not found in this tenant` };
      }
      return {
        success: false,
        error: `Invoice ${live.invoiceNumber} became '${live.status}' while the late fee was being applied — late fee not applied.`,
      };
    }

    // P0-9 — the stored link and any minted PaymentIntent were priced at the
    // pre-fee balance and no longer price what is owed. Both helpers are
    // best-effort and audit every outcome (never throw), so a Stripe failure
    // can't unwind the already-approved fee.
    if (this.paymentLinkCleanup) {
      const actor = { actorId: context.executedBy, actorRole: 'system' };
      await deactivateInvoicePaymentLink({
        tenantId: context.tenantId,
        invoice: updated,
        reason: 'repriced',
        invoiceRepo: this.invoiceRepo,
        provider: this.paymentLinkCleanup.provider,
        connectAccountResolver: this.paymentLinkCleanup.connectAccountResolver,
        auditRepo: this.auditRepo,
        actor,
      });
      await cancelInvoicePaymentIntents({
        tenantId: context.tenantId,
        invoice: updated,
        reason: 'repriced',
        provider: this.paymentLinkCleanup.provider,
        connectAccountResolver: this.paymentLinkCleanup.connectAccountResolver,
        auditRepo: this.auditRepo,
        actor,
      });
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
              newAmountDueCents: updated.amountDueCents,
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
