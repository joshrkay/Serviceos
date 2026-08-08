import { v4 as uuidv4 } from 'uuid';
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
import { applyCreditPayloadSchema } from '../contracts/apply-credit';
import { formatUsdCentsPlain } from '@ai-service-os/shared';

/**
 * Executes an approved `apply_credit` proposal (Tradesperson wave 1, Task 4).
 *
 * Reduces what a customer owes on an issued invoice — goodwill, warranty
 * labor, a price match. Mutation shape mirrors `ApplyLateFeeExecutionHandler`
 * EXACTLY (same file this is adapted from): append a line item, recompute
 * the document totals through the shared billing engine (so the cent-
 * rounding convention can't drift from tax/discount math), then refresh the
 * job money-state rollup. The differences are:
 *
 *   1. The appended line is NEGATIVE (`unitPriceCents: -amountCents`) —
 *      this REDUCES the total instead of raising it.
 *   2. A pre-write FLOOR GUARD: `amountCents` may never exceed the
 *      invoice's current `amountDueCents`. Exceeding it would mean handing
 *      money back that was already collected — that's a refund
 *      (`record_refund`, proposals/execution/record-refund-handler.ts), a
 *      materially different operation that mutates PAYMENTS, not an
 *      invoice's own line items. The guard fails BEFORE any write, naming
 *      both amounts (via `formatUsdCentsPlain`, matching
 *      `RecordRefundExecutionHandler`'s style) and pointing the caller at
 *      `record_refund` instead of silently clamping to zero or partially
 *      applying.
 *
 * Money-class: this only ever runs after explicit owner approval (money
 * proposals never auto-approve).
 *
 * ── No stepKey-style dedup id (deliberate divergence from apply_late_fee) ──
 * `ApplyLateFeeExecutionHandler` keys its line's id on `(invoiceId, stepKey)`
 * because the PERIODIC DUNNING SWEEP can mint a fresh, DISTINCT proposal for
 * the same accrual step on the same invoice — without a deterministic id,
 * two such proposals could double-charge the same fee. `apply_credit` has no
 * sweep and no `stepKey`: each credit is a one-off, human-approved voice
 * action, and re-execution of the SAME proposal is already deduped
 * upstream by `ProposalExecutor`'s `IdempotencyGuard` (proposals/execution/
 * idempotency.ts). Inventing a stepKey-shaped field here to force the same
 * pattern would (a) require a phantom extraction field this contract has no
 * use for, and (b) wrongly collapse two DIFFERENT, separately-approved
 * credits on the same invoice (e.g. two distinct goodwill gestures) into a
 * single line — the deterministic-id pattern solves a problem this type
 * doesn't have. The credit line's id is therefore a plain `uuidv4()`, same
 * as any other newly-appended invoice line (see e.g.
 * invoice-schedule-handler.ts).
 *
 * Same status precondition as `apply_late_fee`: only an ISSUED invoice still
 * carrying a balance (`open` / `partially_paid`) can be credited — never a
 * `draft` that hasn't gone out, and never `paid` / `void` / `canceled`. (A
 * `paid` invoice has `amountDueCents === 0`, so the floor guard above would
 * already refuse any positive credit on it — this status check makes the
 * "why" explicit for `draft`/`void`/`canceled` instead of relying on that
 * side effect.)
 *
 * Mirrors `ApplyLateFeeExecutionHandler`: degrades to a synthetic-id
 * passthrough when no invoiceRepo is wired, returns failed ExecutionResults
 * (never throws through), and emits a failure-soft audit event
 * (`credit.applied`, entityType `invoice`).
 */
export class ApplyCreditExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'apply_credit';

  constructor(
    private readonly invoiceRepo?: InvoiceRepository,
    private readonly auditRepo?: AuditRepository,
    private readonly moneyStateDeps?: RefreshJobMoneyStateDeps,
  ) {}

  // Boot guard (wiring-assertions.ts) fails boot when a pool is configured
  // but this is false — see ApplyLateFeeExecutionHandler's identical probe.
  isFullyWired(): boolean {
    return Boolean(this.invoiceRepo);
  }

  async execute(
    proposal: Proposal,
    context: ExecutionContext,
  ): Promise<ExecutionResult> {
    const parsed = applyCreditPayloadSchema.safeParse(proposal.payload);
    if (!parsed.success) {
      return {
        success: false,
        error: 'Could not determine the credit to apply (missing invoice or amount).',
      };
    }
    const { invoiceId, amountCents, reason } = parsed.data;

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

    // Only an issued invoice still carrying a balance can be credited —
    // same open/partially_paid precondition as apply_late_fee.
    if (invoice.status !== 'open' && invoice.status !== 'partially_paid') {
      return {
        success: false,
        error: `Invoice ${invoice.invoiceNumber} is '${invoice.status}' — not an issued invoice with a balance, so no credit was applied.`,
      };
    }

    // Floor guard — see class doc comment. Fails BEFORE any write.
    if (amountCents > invoice.amountDueCents) {
      return {
        success: false,
        error:
          `Credit (${formatUsdCentsPlain(amountCents)}) exceeds amount due ` +
          `(${formatUsdCentsPlain(invoice.amountDueCents)}) — record a refund instead`,
      };
    }

    const creditLine = buildLineItem(
      uuidv4(),
      reason ? `Credit — ${reason}` : 'Credit',
      1,
      -amountCents,
      invoice.lineItems.length,
      false, // non-taxable: a credit is not itself subject to sales tax
      'other',
    );
    const lineItems = [...invoice.lineItems, creditLine];
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
        error: err instanceof Error ? err.message : 'Failed to apply credit',
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
    // successful credit application.
    if (this.auditRepo) {
      try {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: 'voice_agent',
            eventType: 'credit.applied',
            entityType: 'invoice',
            entityId: updated.id,
            metadata: {
              proposalId: proposal.id,
              proposalType: 'apply_credit',
              amountCents,
              newAmountDueCents: amountDueCents,
              ...(reason ? { reason } : {}),
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
