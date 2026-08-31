import { describe, it, expect } from 'vitest';
import { applyLateFeePayloadSchema } from '../../../src/proposals/contracts/apply-late-fee';

const INVOICE_ID = '550e8400-e29b-41d4-a716-446655440000';

/**
 * #909 (2026-08-31, TASK 2) — `ApplyLateFeeTaskHandler`
 * (ai/tasks/voice-extended-tasks.ts) has ALWAYS written the spoken/typed
 * invoice reference onto `payload.invoiceReference` whenever `invoiceId`
 * doesn't resolve at draft time (confirmed via the existing task-level
 * test 'uses the stated fee amount, keys stepKey=manual, captures the
 * invoice reference', test/ai/tasks/voice-apply-late-fee.test.ts — this is
 * not new behavior). The CONTRACT never declared the field. Declaring it
 * here is what `GATED_REFERENCE_SOURCES.invoiceId.payloadFields`
 * (ai/resolution/gated-reference-resolution.ts) reads from — this test
 * pins that the schema now accurately describes the payload shape the
 * handler actually produces, mirroring `send_payment_reminder`'s identical
 * fix.
 */
describe('apply_late_fee payload contract — invoiceReference', () => {
  const basePayload = {
    invoiceId: INVOICE_ID,
    feeCents: 2500,
    stepKey: 'manual',
  };

  it('validates a fully-resolved payload with NO invoiceReference at all', () => {
    const result = applyLateFeePayloadSchema.safeParse(basePayload);
    expect(result.success).toBe(true);
  });

  it('validates — and PRESERVES in the parsed output — a payload carrying invoiceReference', () => {
    const result = applyLateFeePayloadSchema.safeParse({
      ...basePayload,
      invoiceReference: 'qa-matrix-A-customer',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.invoiceReference).toBe('qa-matrix-A-customer');
    }
  });

  it('a gated draft (no invoiceId yet, only invoiceReference) recognizes the reference key — invoiceId stays required for full validation', () => {
    const result = applyLateFeePayloadSchema.safeParse({
      feeCents: 2500,
      stepKey: 'manual',
      invoiceReference: 'the Henderson invoice',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('invoiceId');
      expect(paths).not.toContain('invoiceReference');
    }
  });
});
