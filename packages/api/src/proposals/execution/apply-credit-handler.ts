import { v5 as uuidv5 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { Invoice, InvoiceRepository } from '../../invoices/invoice';
import { buildLineItem } from '../../shared/billing-engine';
import {
  RefreshJobMoneyStateDeps,
  refreshJobMoneyStateSafe,
} from '../../jobs/job-money-state';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { applyCreditPayloadSchema } from '../contracts/apply-credit';
import type { PaymentLinkCleanupDeps } from '../../invoices/payment';
import {
  cancelInvoicePaymentIntents,
  deactivateInvoicePaymentLink,
} from '../../invoices/invoice-payment-link';
import { formatUsdCentsPlain } from '@ai-service-os/shared';

/** Fixed namespace for credit-line ids (a real UUID, so pg-invoice keeps it). */
const CREDIT_LINE_ID_NAMESPACE = '3f6d2b8e-7a41-4c9d-b2e5-8c1f0a9d4e73';

/**
 * Deterministic, persistence-stable id for the credit line a given approved
 * proposal appends to a given invoice — a re-run of the SAME proposal maps to
 * the SAME line (idempotent), a different proposal to a different line. A
 * valid UUID, because pg-invoice insertLineItems rewrites non-UUID ids.
 */
export function creditLineId(invoiceId: string, proposalId: string): string {
  return uuidv5(`${invoiceId}:credit:${proposalId}`, CREDIT_LINE_ID_NAMESPACE);
}

/**
 * Executes an approved `apply_credit` proposal (Tradesperson wave 1, Task 4).
 *
 * Reduces what a customer owes on an issued invoice — goodwill, warranty
 * labor, a price match. Mutation shape mirrors `ApplyLateFeeExecutionHandler`
 * EXACTLY (same file this is adapted from): append a NON-taxable line item,
 * move the document totals by exactly its amount through the shared billing
 * engine's adjustment path (`applyNonTaxableAdjustment` — tax, discount and
 * processing fee stay as issued, so a discounted + taxed invoice stays
 * creditable instead of tripping the #1288 mixed-taxability refusal), then
 * refresh the job money-state rollup. The differences are:
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
 * ── Per-PROPOSAL deterministic line id (see creditLineId) ──
 * The handler calls Stripe (stale link / PaymentIntent cleanup), so it is
 * `performsExternalIo`: the executor runs it OUTSIDE its transaction and the
 * credit commits on its own, BEFORE the executor's idempotency marker. A
 * crash in that window re-runs the SAME proposal, which `IdempotencyGuard`
 * cannot dedupe (no marker yet). The credit line's id is therefore derived
 * from (invoiceId, proposalId): a re-run finds its own line already present
 * and returns an idempotent success instead of crediting twice. Keying on the
 * PROPOSAL (not a stepKey, as `apply_late_fee` does for its dunning sweep)
 * keeps two DIFFERENT, separately-approved credits on the same invoice (two
 * distinct goodwill gestures) as two lines.
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
 *
 * The append-line-and-adjust write itself is shared with
 * `ApplyLateFeeExecutionHandler`: both call
 * `InvoiceRepository.applyNonTaxableAdjustmentAtomic` (one guarded write
 * deriving amount due from the LIVE amount paid, re-checking status and —
 * for a credit — that it still fits the live balance), then run the same
 * P0-9 stale link / PaymentIntent cleanup. Guards (idempotency, status
 * precondition, floor checks) and audit emission stay per-handler — they
 * differ enough that folding them in would obscure more than it'd save.
 */
export class ApplyCreditExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'apply_credit';
  // H1 — the stale link / PaymentIntent cleanup calls Stripe. Run OUTSIDE the
  // executor transaction (Path B) so the credit commits and releases its
  // invoice row lock before any network round trip (a webhook payment would
  // otherwise block on that lock for the whole call), and so a later rollback
  // can never undo a credit whose old-price link Stripe already killed. Safe
  // to re-run after a crash before the executor's marker: creditLineId makes
  // the re-run an idempotent success. Same posture as record_payment.
  performsExternalIo = true;

  constructor(
    private readonly invoiceRepo?: InvoiceRepository,
    private readonly auditRepo?: AuditRepository,
    private readonly moneyStateDeps?: RefreshJobMoneyStateDeps,
    /**
     * P0-9 — the credit re-prices the invoice, so a hosted payment link
     * minted at the OLD balance must die (a fresh one is minted on demand).
     */
    private readonly paymentLinkCleanup?: PaymentLinkCleanupDeps,
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

    // Idempotency (H1): this proposal's credit line is already on the invoice
    // — a re-run after a crash between the committed credit and the
    // executor's marker. Never credit twice; DO finish the stale-link cleanup
    // the crash may have cut off (it is idempotent: no stored link → no-op,
    // and only PaymentIntents priced above the balance are cancelled).
    const lineId = creditLineId(invoice.id, proposal.id);
    if (invoice.lineItems.some((li) => li.id === lineId)) {
      return this.finishAlreadyAppliedCredit(invoice, proposal, context, amountCents, reason);
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
      lineId,
      reason ? `Credit — ${reason}` : 'Credit',
      1,
      -amountCents,
      invoice.lineItems.length,
      false, // non-taxable: a credit is not itself subject to sales tax
      'other',
    );
    // #10 — one atomic write: the repo appends the line, moves the totals by
    // its amount (applyNonTaxableAdjustment semantics) and derives amount
    // due from the row's LIVE amount paid, so a webhook payment committing
    // after the read above is never overwritten by a snapshot figure.
    let updated: Invoice | null;
    try {
      updated = await this.invoiceRepo.applyNonTaxableAdjustmentAtomic(
        context.tenantId,
        invoice.id,
        creditLine,
        new Date(),
      );
    } catch (err) {
      // Review L5 / N4 — the line id is per PROPOSAL, so a duplicate key on
      // it proves THIS credit is already on the invoice (a concurrent run of
      // the same proposal won; this write rolled back). That is an idempotent
      // success — reporting failure would invite a second, distinct credit.
      if ((err as { code?: unknown } | null)?.code === '23505') {
        const live = await this.invoiceRepo.findById(context.tenantId, invoice.id);
        if (live && live.lineItems.some((li) => li.id === lineId)) {
          return this.finishAlreadyAppliedCredit(live, proposal, context, amountCents, reason);
        }
        return {
          success: false,
          error: `This credit collided with an existing line on invoice ${invoice.invoiceNumber} — not applied.`,
        };
      }
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to apply credit',
      };
    }
    if (!updated) {
      // The atomic write's live guards refused it: the invoice changed after
      // the read above (voided / settled, or a payment shrank the due below
      // this credit) — or vanished. Nothing was written.
      const live = await this.invoiceRepo.findById(context.tenantId, invoice.id);
      if (!live) {
        return { success: false, error: `Invoice ${invoiceId} not found in this tenant` };
      }
      if ((live.status === 'open' || live.status === 'partially_paid') && amountCents > live.amountDueCents) {
        return {
          success: false,
          error:
            `Credit (${formatUsdCentsPlain(amountCents)}) exceeds amount due ` +
            `(${formatUsdCentsPlain(live.amountDueCents)}) — a payment landed while it was being applied; ` +
            `record a refund instead`,
        };
      }
      return {
        success: false,
        error:
          `Invoice ${live.invoiceNumber} changed while the credit was being applied ` +
          `(now '${live.status}', ${formatUsdCentsPlain(live.amountDueCents)} due) — no credit was applied.`,
      };
    }

    await this.killStaleChargeVectors(updated, context);

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
              newAmountDueCents: updated.amountDueCents,
              // Review M2 — a credit that clears a partly-paid balance settles
              // the invoice; the status change rides this audit event.
              oldStatus: invoice.status,
              newStatus: updated.status,
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

  /**
   * Review N4 / N5 — this proposal's credit is already on the invoice: a
   * re-run after a crash between the committed credit and the executor's
   * marker, or a concurrent run of the same proposal that won the line's
   * primary key. Never credit again; finish what the earlier run may not
   * have reached — the stale-charge cleanup, the job money-state rollup, and
   * the `credit.applied` event (written only when none exists for this
   * proposal, so a re-run never double-audits) — and report success.
   */
  private async finishAlreadyAppliedCredit(
    invoice: Invoice,
    proposal: Proposal,
    context: ExecutionContext,
    amountCents: number,
    reason: string | undefined,
  ): Promise<ExecutionResult> {
    await this.killStaleChargeVectors(invoice, context);
    if (this.moneyStateDeps) {
      await refreshJobMoneyStateSafe(context.tenantId, invoice.jobId, 'system', this.moneyStateDeps);
    }
    if (this.auditRepo) {
      try {
        const prior = await this.auditRepo.findByEntity(context.tenantId, 'invoice', invoice.id);
        const alreadyAudited = prior.some(
          (e) =>
            e.eventType === 'credit.applied' &&
            (e.metadata as Record<string, unknown> | undefined)?.proposalId === proposal.id,
        );
        if (!alreadyAudited) {
          await this.auditRepo.create(
            createAuditEvent({
              tenantId: context.tenantId,
              actorId: context.executedBy,
              actorRole: 'voice_agent',
              eventType: 'credit.applied',
              entityType: 'invoice',
              entityId: invoice.id,
              metadata: {
                proposalId: proposal.id,
                proposalType: 'apply_credit',
                amountCents,
                newAmountDueCents: invoice.amountDueCents,
                newStatus: invoice.status,
                recoveredOnRetry: true,
                ...(reason ? { reason } : {}),
              },
            }),
          );
        }
      } catch {
        // swallow — audit must never fail the execution
      }
    }
    return { success: true, resultEntityId: invoice.id };
  }

  /**
   * P0-9 — the stored link and any minted PaymentIntent were priced at the
   * pre-credit balance; left live they would charge the customer more than
   * is now owed. Both helpers are best-effort and audit every outcome (never
   * throw), so a Stripe failure can't unwind the approved credit.
   */
  private async killStaleChargeVectors(invoice: Invoice, context: ExecutionContext): Promise<void> {
    if (!this.paymentLinkCleanup || !this.invoiceRepo) return;
    const actor = { actorId: context.executedBy, actorRole: 'voice_agent' };
    await deactivateInvoicePaymentLink({
      tenantId: context.tenantId,
      invoice,
      reason: 'repriced',
      invoiceRepo: this.invoiceRepo,
      provider: this.paymentLinkCleanup.provider,
      connectAccountResolver: this.paymentLinkCleanup.connectAccountResolver,
      auditRepo: this.auditRepo,
      actor,
    });
    await cancelInvoicePaymentIntents({
      tenantId: context.tenantId,
      invoice,
      reason: 'repriced',
      provider: this.paymentLinkCleanup.provider,
      connectAccountResolver: this.paymentLinkCleanup.connectAccountResolver,
      auditRepo: this.auditRepo,
      actor,
    });
  }
}
