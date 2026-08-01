# Phase 5 — Invoice Intelligence + Payments: Launch Readiness Gaps

> **4 stories** | Continues from P5-015

---

## Purpose

The invoice and payment backend is largely implemented (Stripe webhook handler, payment link generation, reconciliation). The gap is the frontend payment experience and production safety guards around the mock payment provider.

## Exit Criteria

Customers can pay invoices via Stripe Elements; mock payment provider is blocked in production; payment confirmation flows back to the invoice UI; invoice delivery notifies the customer.

## Gap Summary

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P5-016 | Integrate Stripe Elements in InvoicePaymentPage | S | Payments/UI | Medium | Heavy | P0-029, P5-010D |
| P5-017 | Guard MockPaymentLinkProvider in production | XS | Payments | High | Moderate | P0-026 |
| P5-018 | Payment confirmation flow to frontend | S | Payments/UI | High | Moderate | P5-010E, P5-010F, P0-032 |
| P5-019 | Invoice delivery notification via email or SMS | S | Notifications | Medium | Moderate | P5-005, P0-009 |

---

## Story Specifications

### P5-016 — Integrate Stripe Elements in InvoicePaymentPage

> **Size:** S | **Layer:** Payments/UI | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P0-029, P5-010D

**Allowed files:** `packages/web/src/components/customer/InvoicePaymentPage.tsx, packages/web/package.json`

**Build prompt:** The InvoicePaymentPage at `/pay/:id` has a card form UI that captures card number, expiry, and CVC — but it processes payment with a `setTimeout` fake (1.6 second delay). Replace with real Stripe integration: (1) Install `@stripe/react-stripe-js` and `@stripe/stripe-js`. (2) Wrap the payment form in `<Elements>` provider. (3) Replace the manual card input fields with Stripe's `<PaymentElement>` (supports card, ACH, bank). (4) On submit, call `stripe.confirmPayment()` with the client secret from the backend. (5) Handle success, failure, and processing states. (6) The backend endpoint `POST /api/payments/create-payment-intent` should return the client secret. This is a PCI-sensitive area — Stripe Elements handles card data, never our server.

**Review prompt:** Verify NO card data ever touches our server (Stripe Elements handles it). Verify the setTimeout fake is completely removed. Verify the Stripe publishable key comes from environment, not hardcoded. Verify all payment states are handled (success, failure, processing, requires_action). Verify the payment page works without authentication (it's a customer-facing public page). Check mobile responsiveness of PaymentElement.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-016"
grep -r "setTimeout" packages/web/src/components/customer/InvoicePaymentPage.tsx | wc -l  # Should be 0
```

**Required tests:**
- [ ] Happy path — Stripe Elements renders payment form
- [ ] Success — payment confirmed, success state shown
- [ ] Failure — card declined, error message shown
- [ ] Processing — "Processing..." state while Stripe works
- [ ] No auth required — page accessible without sign-in
- [ ] Mobile — PaymentElement renders correctly on small screens

---

### P5-017 — Guard MockPaymentLinkProvider in production

> **Size:** XS | **Layer:** Payments | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-026

**Allowed files:** `packages/api/src/payments/payment-link-provider.ts, packages/api/src/app.ts`

**Build prompt:** The `MockPaymentLinkProvider` in `payments/payment-link-provider.ts` generates URLs like `https://pay.mock.com/...` and is currently exported alongside real provider interfaces. In production, this must never be used. Add a guard: (1) If `NODE_ENV=production` and the payment provider resolves to `MockPaymentLinkProvider`, throw a startup error. (2) In `app.ts`, instantiate the real `StripePaymentLinkProvider` when `STRIPE_SECRET_KEY` is present. (3) Only fall back to mock in `development` or `test` environments. (4) Log a warning in development when using the mock provider.

**Review prompt:** Verify `MockPaymentLinkProvider` is unreachable in production. Verify `STRIPE_SECRET_KEY` is required in production (validated in P0-026 env schema). Verify dev/test environments still work with mock. Check that mock URLs can never accidentally reach a customer.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-017"
```

**Required tests:**
- [ ] Production guard — mock provider throws in production
- [ ] Real provider — Stripe provider used when key present
- [ ] Dev fallback — mock used in development without key
- [ ] Warning — dev mode logs warning about mock usage

---

### P5-018 — Payment confirmation flow to frontend

> **Size:** S | **Layer:** Payments/UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P5-010E, P5-010F, P0-032

**Allowed files:** `packages/web/src/components/customer/**, packages/web/src/components/invoices/**`

**Build prompt:** After a customer pays an invoice via Stripe, the payment flows back through the Stripe webhook → backend reconciliation → invoice status update. Wire the frontend to reflect this: (1) On the InvoicePaymentPage, after successful Stripe payment, show a confirmation screen with receipt details. (2) On the internal InvoicesPage (dispatcher view), update the invoice status in real-time or on next poll. (3) Show a toast notification when a payment is received on any open invoice. (4) The invoice detail view should show payment history (amounts, dates, methods).

**Review prompt:** Verify the customer sees a clear confirmation after payment. Verify the internal invoice view updates without manual refresh. Verify payment history shows on invoice detail. Verify partial payments show remaining balance. Check that the confirmation page doesn't expose sensitive payment data.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-018"
```

**Required tests:**
- [ ] Customer confirmation — success screen shown after payment
- [ ] Internal update — invoice status updates after webhook processes
- [ ] Toast — dispatcher notified of new payment
- [ ] Payment history — amounts and dates shown on invoice detail
- [ ] Partial payment — remaining balance displayed correctly

---

### P5-019 — Invoice delivery notification via email or SMS

> **Size:** S | **Layer:** Notifications | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P5-005, P0-009

**Allowed files:** `packages/api/src/invoices/**, packages/api/src/workers/**`

**Build prompt:** When an invoice is approved and executed (status moves to `open`), the customer should be notified. Implement a notification worker that: (1) Listens for `invoice.opened` events on the async queue. (2) Sends an email or SMS to the customer with a link to the payment page (`/pay/:id`). (3) Uses the customer's preferred communication channel (from P1-002). (4) Records the notification in the audit log. For MVP, use a simple email provider (SendGrid, SES) or queue the notification for manual sending if no provider is configured. Do not block invoice execution on notification delivery.

**Review prompt:** Verify notification is async (does not block invoice execution). Verify customer preference is respected. Verify payment link is correct and functional. Verify audit event is recorded. Check that notification failures are logged but don't affect invoice state.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-019"
```

**Required tests:**
- [ ] Happy path — invoice opened triggers notification
- [ ] Async — notification doesn't block invoice execution
- [ ] Customer preference — email vs SMS respected
- [ ] Payment link — correct `/pay/:id` URL included
- [ ] Failure tolerance — notification failure logged, invoice unaffected
- [ ] Audit — notification event recorded
