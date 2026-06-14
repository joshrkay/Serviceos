import { z } from 'zod';

/**
 * send_payment_reminder proposal payload.
 *
 * Raised by the overdue-invoice sweep (workers/overdue-invoice-worker.ts)
 * for each due reminder step of a tenant's dunning cadence
 * (invoices/dunning-schedule.ts). Delivers an overdue-payment reminder to
 * the customer on the configured channel.
 *
 * Customer-comms action → comms-class (actionClassForProposalType): per
 * Decision 3 and CLAUDE.md "Never auto-execute", it never auto-approves
 * regardless of trust tier. The owner approves it (screen-tap / queue /
 * digest one-tap) before the customer is contacted; the actual send is
 * performed by SendPaymentReminderExecutionHandler on approval.
 *
 * `stepKey` is the dunning ledger's stable per-step idempotency key
 * (`'<offsetDays>:<channel>'`, see reminderStepKey) — carried so the
 * execution + audit trail ties back to the exact cadence step.
 */
export const sendPaymentReminderPayloadSchema = z.object({
  invoiceId: z.string().uuid(),
  /** Stable dunning-step key (`reminderStepKey`), e.g. "3:sms". */
  stepKey: z.string().min(1),
  /** Days past the due date this reminder step fires. */
  offsetDays: z.number().int().nonnegative(),
  /** Channel the reminder is delivered on. */
  channel: z.enum(['sms', 'email']),
});

export type SendPaymentReminderPayload = z.infer<
  typeof sendPaymentReminderPayloadSchema
>;
