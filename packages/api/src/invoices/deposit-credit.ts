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
 *   - Updates the invoice's amountPaidCents + amountDueCents + status.
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
  //   - If paymentRepo.create SUCCEEDS but invoiceRepo.update fails,
  //     rolling back the marker is UNSAFE: the orphan payment row
  //     plus a re-credit on retry would credit the deposit twice
  //     (once via the orphan, once via the retry's fresh payment).
  //     In that case we LEAVE the marker set and let the failure
  //     audit (in the calling route) flag it for reconciliation.
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
    };
    await paymentRepo.create(payment);
    paymentWritten = true;

    const newAmountPaid = invoice.amountPaidCents + credit;
    const newAmountDue = Math.max(0, invoice.totals.totalCents - newAmountPaid);
    // Status only gets bumped from draft if the credit was the FULL
    // amount. Otherwise the invoice stays in draft until the operator
    // issues it (existing flow). For draft → draft we just update
    // the cents fields.
    const updatedInvoice = await invoiceRepo.update(invoice.tenantId, invoice.id, {
      amountPaidCents: newAmountPaid,
      amountDueCents: newAmountDue,
      updatedAt: now,
    });
    if (!updatedInvoice) {
      throw new Error(
        `Failed to update invoice ${invoice.id} with deposit credit ${credit}`,
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
