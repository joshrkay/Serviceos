import { z } from 'zod';

/**
 * record_refund proposal payload (Tradesperson wave 1, Task 3).
 *
 * Records a MANUAL refund (cash / check / a card swiped outside Stripe /
 * other) given back to a customer against an existing invoice. Money-class
 * — always drafted, never auto-approved (D3), per CLAUDE.md "Never
 * auto-execute" and Decision 3 "money class never auto-approves".
 *
 * Stripe-AUTOMATED refunds are explicitly OUT OF SCOPE here (YAGNI) — see
 * `RecordRefundExecutionHandler` (proposals/execution/record-refund-handler.ts)
 * for the full analysis of why this reuses the existing `recordRefund()`
 * domain function (payments/payment-service.ts) rather than a new refund
 * ledger.
 *
 * `invoiceId` is a resolved, verified UUID — the spoken invoice reference is
 * resolved to it BEFORE this payload is built (entity-resolution.ts
 * INVOICE_DOC_INTENTS membership), mirroring `record_payment`. Unlike
 * `record_payment`'s contract, there is deliberately NO `invoiceReference`
 * alternative field: an unresolved reference gates the proposal
 * (`missingFields: ['invoiceId']`) rather than persisting free text a later
 * step must still resolve.
 *
 * Amount is in integer cents (never floating point — CLAUDE.md core
 * patterns).
 */
export const RECORD_REFUND_METHODS = ['cash', 'check', 'card_external', 'other'] as const;
export type RecordRefundMethod = (typeof RECORD_REFUND_METHODS)[number];

export const recordRefundPayloadSchema = z.object({
  invoiceId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  method: z.enum(RECORD_REFUND_METHODS),
  reason: z.string().max(1000).optional(),
  checkNumber: z.string().max(100).optional(),
});

export type RecordRefundPayload = z.infer<typeof recordRefundPayloadSchema>;
