import { z } from 'zod';

/**
 * apply_late_fee proposal payload.
 *
 * Raised by the overdue-invoice sweep (workers/overdue-invoice-worker.ts)
 * when a tenant's dunning policy makes a late fee due on an overdue invoice
 * (computed by invoices/late-fee.ts:computeLateFeeCents). Appends the fee as
 * a non-taxable line item to the invoice on approval.
 *
 * Money-moving action → money-class (actionClassForProposalType): per
 * Decision 3 and CLAUDE.md "Never auto-execute", money-class proposals never
 * auto-approve regardless of confidence / trust tier. The owner must approve
 * deliberately before the fee is applied; the mutation is performed by
 * ApplyLateFeeExecutionHandler on approval.
 *
 * `feeCents` is the already-computed fee amount in integer cents (never
 * floating point — see CLAUDE.md core patterns). `stepKey` is the dunning
 * ledger's accrual-period key (`LATE_FEE_ONE_TIME_KEY` = "initial" for the
 * current one-time-fee policy) so the execution + audit trail ties back to
 * the ledger row that gated this proposal.
 */
export const applyLateFeePayloadSchema = z.object({
  invoiceId: z.string().uuid(),
  /** Late fee to apply, in integer cents. */
  feeCents: z.number().int().positive(),
  /** Dunning ledger accrual-period key (e.g. "initial"). */
  stepKey: z.string().min(1),
});

export type ApplyLateFeePayload = z.infer<typeof applyLateFeePayloadSchema>;
