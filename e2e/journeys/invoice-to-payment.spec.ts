import { test } from '@playwright/test';

/**
 * Journey 3 — Invoice is sent and paid via Stripe.
 *
 * W1-2 continuous CI proof lives in:
 *   e2e/money-loop/invoice-webhook-paid.spec.ts  (hermetic /pay UI)
 *   packages/api/test/webhooks/invoice-webhook-paid.test.ts
 *   packages/api/test/integration/invoice-webhook-paid.test.ts
 *
 * Thread: docs/plans/wave1/W1-2-invoice-webhook-paid.md
 *
 * Live Stripe test-mode + Elements card entry remain out of scope for W1-2.
 * This file stays as the journey index entry and stays skipped so CI cannot
 * report a false-green Journey 3 without running the money-loop proof.
 */

test.describe('Journey 3 — invoice to Stripe payment', () => {
  test.skip(
    'approved invoice generates payment link and marks paid on webhook',
    async () => {
      // W1-2: run e2e/money-loop/invoice-webhook-paid.spec.ts
      // (+ API webhook proofs) instead of live Stripe Elements.
    },
  );
});
