import { v4 as uuidv4 } from 'uuid';
import { Invoice, InvoiceRepository } from './invoice';
import { Payment, PaymentRepository } from './payment';
import { Job, JobRepository } from '../jobs/job';

/**
 * Tier 4 (Deposit rules — PR 3c). Apply a previously-paid deposit on a
 * job to a freshly-created invoice for that job:
 *
 *   - Inserts a Payment row (method='other', providerReference='deposit_credit')
 *     so the invoice's payment history is complete and the standard
 *     amountPaid / amountDue accounting stays accurate.
 *   - Credits the invoice's balance via the atomic guarded increment
 *     (InvoiceRepository.applyDepositCreditAtomic — Track-5), never a
 *     read-modify-write from this call's earlier snapshot.
 *   - Marks the job's deposit as consumed (depositCreditedToInvoiceId)
 *     so a subsequent invoice from the same job (rare; change-orders)
 *     does not re-credit an already-applied deposit.
 *
 * Idempotency: a no-op when the job has no paid deposit OR the deposit
 * has already been credited to another invoice. Returns the credited
 * amount + updated invoice on success; null when nothing was credited.
 *
 * Lives separate from `recordPayment` because:
 *   - recordPayment requires invoice.status ∈ {open, partially_paid};
 *     this credit lands on a freshly-created `draft` invoice.
 *   - We don't want this in the user-visible payment-method enum
 *     (it's a system-level transfer between job and invoice, not a
 *     real transaction the customer made against the invoice).
 */
export interface DepositCreditResult {
  invoice: Invoice;
  payment: Payment;
  creditCents: number;
}

export async function applyDepositCreditToInvoice(
  invoice: Invoice,
  job: Job,
  invoiceRepo: InvoiceRepository,
  paymentRepo: PaymentRepository,
  jobRepo: JobRepository,
): Promise<DepositCreditResult | null> {
  const depositPaid = job.depositPaidCents ?? 0;
  if (depositPaid <= 0) return null;
  if (job.depositCreditedToInvoiceId) return null;
  if (invoice.totals.totalCents <= 0) return null;

  // Cap at the invoice total so we never produce a negative amountDue.
  // Any leftover deposit (rare — would mean rule changed downward)
  // remains on the job; a follow-up reconciliation flow can handle it.
  const credit = Math.min(depositPaid, invoice.totals.totalCents);

  // Atomically claim the deposit BEFORE writing the payment row.
  // Two concurrent invoice-creation requests would otherwise both
  // pass the `depositCreditedToInvoiceId` pre-check above and each
  // create a deposit_credit Payment, applying the deposit twice.
  // The conditional UPDATE in atomicallyConsumeDeposit returns null
  // when another caller beat us — bail out cleanly with no side
  // effects in that case.
  //
  // Repos that don't implement the atomic method (legacy fakes) fall
  // back to the read-then-write path; the InMemoryJobRepository
  // SHIPS atomicallyConsumeDeposit so production-shape tests stay
  // race-safe. The fallback is only for fake repos in unit tests
  // that intentionally subset the interface.
  if (jobRepo.atomicallyConsumeDeposit) {
    const claimed = await jobRepo.atomicallyConsumeDeposit(
      job.tenantId,
      job.id,
      invoice.id,
    );
    if (!claimed) return null;
  } else {
    // Defense in depth for legacy fakes — no atomicity guarantee.
    await jobRepo.update(job.tenantId, job.id, {
      depositCreditedToInvoiceId: invoice.id,
      updatedAt: new Date(),
    });
  }

  // PR 319 review (P1 — Codex, two iterations): the atomic claim
  // above marks the deposit consumed BEFORE the payment + invoice
  // updates land. We need to be careful with rollback semantics:
  //
  //   - If paymentRepo.create FAILS — no payment row was written,
  //     rolling back the marker is safe (the deposit becomes
  //     available for a retry; no risk of double-credit).
  //   - If paymentRepo.create SUCCEEDS but the atomic invoice credit
  //     THROWS (repo outage), rolling back the marker is UNSAFE: the
  //     orphan ACTIVE payment row plus a re-credit on retry would
  //     credit the deposit twice (once via the orphan, once via the
  //     retry's fresh payment). In that case we LEAVE the marker set
  //     and let the failure audit (in the calling route) flag it for
  //     reconciliation.
  //   - If the atomic credit is REJECTED by its guards (null — the
  //     invoice left the creditable set or the credit no longer fits
  //     the balance), the payment row is compensated to 'failed'
  //     first; once inert, releasing the marker is safe (see the
  //     rejection branch below).
  //
  // Without a Pg transaction wrapping both writes, this is the
  // smallest correct guarantee. recordPayment in payment.ts has the
  // same pre-existing risk; closing it for both is a follow-up.
  let paymentWritten = false;
  try {
    const now = new Date();
    const payment: Payment = {
      id: uuidv4(),
      tenantId: invoice.tenantId,
      invoiceId: invoice.id,
      amountCents: credit,
      method: 'other',
      status: 'completed',
      providerReference: 'deposit_credit',
      note: `Deposit credit from job ${job.jobNumber}`,
      receivedAt: now,
      processedBy: 'system',
      createdAt: now,
      updatedAt: now,
      refundedAmountCents: 0,
      refundedAt: null,
      lastRefundStripeId: null,
      reversedAt: null,
      reversalReason: null,
    };
    await paymentRepo.create(payment);
    paymentWritten = true;

    // Credit the invoice ATOMICALLY (Track-5). This was the last
    // read-modify-write writer of the invoice balance: it computed
    // `invoice.amountPaidCents + credit` from the caller's snapshot and wrote
    // it absolutely via the generic update(), so a concurrent credit landing
    // via incrementAmountPaidAtomic between that read and this write was
    // silently overwritten — the invoice under-credited the customer and
    // amount_paid_cents fell below the active payment-ledger sum. It also
    // bypassed the payable-status and balance-cap predicates P0-3/P0-6 put in
    // SQL. applyDepositCreditAtomic derives the new paid/due/status from the
    // row's OWN current values in one guarded UPDATE (same convention as
    // incrementAmountPaidAtomic, plus 'draft' in the status list — the credit
    // lands on the freshly-created draft at both call sites, and a draft
    // stays 'draft': issuing remains the operator's explicit step).
    const updatedInvoice = await invoiceRepo.applyDepositCreditAtomic(
      invoice.tenantId,
      invoice.id,
      credit,
      now,
    );
    if (!updatedInvoice) {
      // Guard rejection, never a silent success: the invoice vanished, left
      // the creditable set ('draft'/'open'/'partially_paid' — e.g. it was
      // voided/canceled/settled after our snapshot read), or the credit no
      // longer fits the remaining balance (a concurrent payment landed
      // first). Mirror recordPayment's credit-rejection compensation
      // (payment.ts): the deposit payment row already committed, so flip it
      // to 'failed' (excluded from every paid-ledger sum) rather than leave a
      // completed row with no matching invoice credit. No "already credited
      // on our behalf" ledger check is needed here: deposit rows use
      // method='other', which the unique-reference reconcile branch never
      // touches. If this compensation write throws, the outer catch keeps the
      // consumed marker set (an ACTIVE orphan row must block a re-credit) and
      // the callers' failure audit flags it for reconciliation.
      const rejectedAt = new Date();
      await paymentRepo.update(invoice.tenantId, payment.id, {
        status: 'failed',
        reversedAt: rejectedAt,
        reversalReason: 'credit_rejected',
        updatedAt: rejectedAt,
      });
      // With the payment row inert a retry cannot double-credit, so releasing
      // the consumed marker is safe — and money-correct: the deposit is real
      // customer money and must stay available to credit to a live invoice
      // instead of being consumed by one that took nothing.
      try {
        await jobRepo.update(job.tenantId, job.id, {
          depositCreditedToInvoiceId: undefined,
          updatedAt: new Date(),
        });
      } catch {
        // Best-effort: the rejection below still surfaces the state — both
        // call sites audit/log the thrown error for manual reconciliation.
      }
      const live = await invoiceRepo.findById(invoice.tenantId, invoice.id);
      throw new Error(
        `Deposit credit of ${credit} cents rejected for invoice ${invoice.id} ` +
          `(live status='${live?.status ?? 'missing'}', ` +
          `amountPaidCents=${live?.amountPaidCents ?? 'n/a'}, ` +
          `totalCents=${live?.totals.totalCents ?? 'n/a'}); ` +
          `deposit payment ${payment.id} was compensated to 'failed' and the ` +
          `job's deposit was released for reconciliation`,
      );
    }

    return { invoice: updatedInvoice, payment, creditCents: credit };
  } catch (err) {
    // Only roll back the marker when no payment was written. See
    // comment above for why we DON'T roll back when paymentWritten
    // is true: the orphan payment row would let a retry double-credit.
    if (!paymentWritten) {
      try {
        // Setting the field to undefined drops to SQL NULL via the
        // pg-job repo's `value ?? null` translation, which is what we
        // want — back to "deposit not yet consumed" so a retry picks
        // it up.
        await jobRepo.update(job.tenantId, job.id, {
          depositCreditedToInvoiceId: undefined,
          updatedAt: new Date(),
        });
      } catch {
        // Best-effort. Original error wins.
      }
    }
    throw err;
  }
}
