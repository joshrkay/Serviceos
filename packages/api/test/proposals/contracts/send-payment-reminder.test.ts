import { describe, it, expect } from 'vitest';
import { sendPaymentReminderPayloadSchema } from '../../../src/proposals/contracts/send-payment-reminder';

const INVOICE_ID = '550e8400-e29b-41d4-a716-446655440000';

/**
 * #909 (2026-08-31, TASK 2 — apply_late_fee/send_payment_reminder audit) —
 * `SendPaymentReminderTaskHandler` (ai/tasks/voice-extended-tasks.ts) has
 * ALWAYS written the spoken/typed invoice reference onto
 * `payload.invoiceReference` whenever `invoiceId` doesn't resolve at draft
 * time (confirmed: this is not new behavior). The CONTRACT never declared
 * the field, unlike its siblings `sendInvoicePayloadSchema` /
 * `recordPaymentPayloadSchema`, which both already have it. Declaring it
 * here is what `GATED_REFERENCE_SOURCES.invoiceId.payloadFields`
 * (ai/resolution/gated-reference-resolution.ts) reads from — this test pins
 * that the schema now accurately describes the payload shape the handler
 * actually produces.
 */
describe('send_payment_reminder payload contract — invoiceReference', () => {
  const basePayload = {
    invoiceId: INVOICE_ID,
    stepKey: 'manual',
    offsetDays: 0,
    channel: 'sms' as const,
  };

  it('validates a fully-resolved payload with NO invoiceReference at all', () => {
    const result = sendPaymentReminderPayloadSchema.safeParse(basePayload);
    expect(result.success).toBe(true);
  });

  it('validates — and PRESERVES in the parsed output — a payload carrying invoiceReference', () => {
    const result = sendPaymentReminderPayloadSchema.safeParse({
      ...basePayload,
      invoiceReference: 'qa-matrix-A-customer',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.invoiceReference).toBe('qa-matrix-A-customer');
    }
  });

  it('a gated draft (no invoiceId yet, only invoiceReference) still validates the field — invoiceId stays required for a FULLY-resolved payload, but the reference key itself is never rejected as unknown', () => {
    // Draft-time persistence never Zod-validates (createProposal writes the
    // payload as-is), so an unresolved gate with invoiceId absent is
    // already safe today — this pins that the SCHEMA, in isolation, at
    // least recognizes the reference key rather than silently discarding
    // it were some future caller to `.parse()` a gated payload directly.
    const result = sendPaymentReminderPayloadSchema.safeParse({
      stepKey: 'manual',
      offsetDays: 0,
      channel: 'sms',
      invoiceReference: 'the Henderson invoice',
    });
    // invoiceId is still required by this schema — a gated (invoiceId-less)
    // payload fails full validation, exactly as before this fix. What
    // changed is `invoiceReference` no longer being an unrecognized key.
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('invoiceId');
      expect(paths).not.toContain('invoiceReference');
    }
  });
});
