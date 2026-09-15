import { z } from 'zod';

/**
 * apply_credit proposal payload (Tradesperson wave 1, Task 4).
 *
 * Reduces what a customer owes on an ISSUED invoice — goodwill, warranty
 * labor, a price match. Mirrors `apply_late_fee` exactly, but with a
 * NEGATIVE, floor-guarded line: a credit can never bring `amountDueCents`
 * below zero, because that would mean handing money BACK that was already
 * collected — that's a refund (`record_refund`'s job), a materially
 * different operation that touches payments, not an invoice's own line
 * items. `ApplyCreditExecutionHandler` (proposals/execution/
 * apply-credit-handler.ts) enforces the floor with a pre-write guard and
 * points the caller at `record_refund` when a credit would exceed the
 * amount due.
 *
 * Money-moving action → money-class (actionClassForProposalType): per
 * Decision 3 and CLAUDE.md "Never auto-execute", money-class proposals
 * never auto-approve regardless of confidence / trust tier. The owner must
 * approve deliberately before the credit is applied.
 *
 * `amountCents` is the credit amount in integer cents (never floating
 * point — see CLAUDE.md core patterns). `reason` is optional free text
 * ("goodwill — repeat leak") folded into the appended line's description;
 * omitted entirely when unstated (never a fabricated blank).
 */
export const applyCreditPayloadSchema = z.object({
  invoiceId: z.string().uuid(),
  /** Credit to apply, in integer cents. Must be positive — floor-guarded against the invoice's amount due at execution time. */
  amountCents: z.number().int().positive(),
  /** Why the credit was given (goodwill / warranty labor / price match), folded into the appended line's description. */
  reason: z.string().max(1000).optional(),
});

export type ApplyCreditPayload = z.infer<typeof applyCreditPayloadSchema>;
