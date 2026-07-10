import { test } from '@playwright/test';

/**
 * Journey 3 — Invoice is sent and paid via Stripe.
 *
 * W1-2 moved the continuous CI proof to:
 *   e2e/money-loop/invoice-webhook-paid.spec.ts
 *
 * That hermetic spec proves signed webhook → paid on `/pay/:token` without
 * Stripe Elements/Checkout UI. API-side signed-handler + durable idempotency
 * proofs:
 *   packages/api/test/webhooks/invoice-webhook-paid.test.ts
 *   packages/api/test/integration/invoice-webhook-paid.test.ts
 *
 * Thread: docs/plans/wave1/W1-2-invoice-webhook-paid.md
 *
 * Live Stripe test-mode + Elements card entry remain out of scope for W1-2
 * (Wave 1.1 / later). This file stays as the journey index entry and
 * delegates so `npm run e2e` does not double-run the same assertions.
 */

test.describe('Journey 3 — invoice to Stripe payment', () => {
  test('delegates to W1-2 hermetic money-loop proof', async () => {
    // Executable coverage lives in e2e/money-loop/invoice-webhook-paid.spec.ts.
    // Keep this describe registered so journey docs / grep stay accurate.
    test.info().annotations.push({
      type: 'w1-2',
      description: 'See e2e/money-loop/invoice-webhook-paid.spec.ts',
    });
  });
});
