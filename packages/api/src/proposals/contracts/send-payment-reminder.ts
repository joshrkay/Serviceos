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
 *
 * `invoiceReference` (#909, 2026-08-31) — the spoken/typed invoice
 * reference `SendPaymentReminderTaskHandler` (ai/tasks/voice-extended-
 * tasks.ts) already writes onto the payload whenever `invoiceId` doesn't
 * resolve at draft time (mirrors `sendInvoicePayloadSchema`/
 * `recordPaymentPayloadSchema`'s identical field). It was never declared
 * here — draft-time persistence doesn't Zod-validate (`createProposal`
 * writes the payload as-is), so this was invisible on the happy path, but
 * `editProposal` DOES re-validate the full merged payload on every field
 * edit and silently strips any undeclared key, including this one, on an
 * edit to an unrelated field (e.g. the reviewer nudging `channel`) —
 * exactly the risk #935/#947 closed for `jobReference`/`itemReference`.
 * Read by `GATED_REFERENCE_SOURCES.invoiceId.payloadFields`
 * (ai/resolution/gated-reference-resolution.ts) so the post-draft chat
 * loop can resolve-or-ask on it.
 */
export const sendPaymentReminderPayloadSchema = z.object({
  invoiceId: z.string().uuid(),
  invoiceReference: z.string().optional(),
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
