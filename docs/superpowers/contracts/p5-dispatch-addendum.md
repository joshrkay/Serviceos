# Phase 5 (Payments) — Multi-Agent Dispatch Addendum

This addendum extends `docs/stories/phase-5-gap-stories.md` with dispatch metadata for the four payment-flow gap stories.

For every story, the agent prompt should include:
- The full body of the story from `phase-5-gap-stories.md`
- This addendum's per-story block
- `repository-conventions.md` and `freeze-list.md` from `docs/superpowers/contracts/`

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| 5A | P5-017 | single agent (production safety) | release gate — must merge before any further payment work |
| 5B | P5-016, P5-019 | parallel (2 agents) | none |
| 5C | P5-018 | single agent, after 5B merges | release gate |

P5-017 is the **only one with security implications**; it should ship first regardless of UX work order.

---

## P5-017 — Guard MockPaymentLinkProvider in production

**Wave:** 5A (priority — production-safety guard)
**Migration number reserved:** none
**Forbidden files:**
- `packages/api/src/payments/stripe-payment-link.ts` (do not touch real provider)
- `packages/api/src/payments/stripe-webhook-handler.ts` (out of scope)
- `packages/shared/**`
- any frontend file
- `packages/api/src/db/schema.ts` (no migration)

**Allowed files:**
- `packages/api/src/payments/payment-link-provider.ts`
- `packages/api/src/app.ts` (only the provider-instantiation lines)
- `packages/api/src/payments/payment-link-provider.test.ts`
- `packages/api/src/shared/config.ts` (only if extending production-config validator)

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run --grep "P5-017|MockPaymentLinkProvider" && \
  grep -nE "new MockPaymentLinkProvider\(\)" packages/api/src/app.ts | (! grep -v "NODE_ENV !== 'production'")
```

The final grep ensures any direct instantiation of the mock is guarded by an explicit non-production check.

**Pre-flight:**
- `git fetch origin && git rev-parse origin/main` succeeds.
- `validateProductionConfig` in `shared/config.ts` is in place (already shipped).

**Risk note:** Failure mode is silent — if this regresses, production will accept payments via a mock provider that returns synthetic payment URLs. The verification gate is constructed to fail closed (the grep returns 0 hits unless guarded). Verify manually post-merge that a production-mode startup throws with `STRIPE_SECRET_KEY` missing.

**Implementation hint for the dispatched agent:**
1. In `payment-link-provider.ts`, add a factory `createPaymentLinkProvider(env)` that:
   - Returns `StripePaymentLinkProvider` when `env.STRIPE_SECRET_KEY` is set.
   - Returns `MockPaymentLinkProvider` only when `env.NODE_ENV !== 'production'` AND `env.STRIPE_SECRET_KEY` is missing.
   - **Throws** in production if `STRIPE_SECRET_KEY` is missing.
2. Replace direct `new MockPaymentLinkProvider()` in `app.ts` with the factory call.
3. Add a unit test that asserts the factory throws in production-mode without a Stripe key.
4. Add a unit test that asserts the factory returns the mock in development-mode.

---

## P5-016 — Integrate Stripe Elements in InvoicePaymentPage

**Wave:** 5B (parallel)
**Migration number reserved:** none
**Forbidden files:**
- `packages/api/**` (frontend-only story)
- `packages/web/src/pages/**` (only the InvoicePaymentPage component is allowed)
- `packages/shared/**`

**Allowed files:**
- `packages/web/src/components/customer/InvoicePaymentPage.tsx`
- `packages/web/src/components/customer/InvoicePaymentPage.test.tsx`
- `packages/web/package.json` (adding `@stripe/react-stripe-js` and `@stripe/stripe-js`)
- `packages/web/package-lock.json` (auto-updated)

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  npm run typecheck && \
  npm test --workspace=packages/web -- --run --grep "P5-016|InvoicePaymentPage" && \
  grep -nE "setTimeout" packages/web/src/components/customer/InvoicePaymentPage.tsx | (! grep .) && \
  grep -nE "@stripe/react-stripe-js" packages/web/src/components/customer/InvoicePaymentPage.tsx | grep .
```

**Pre-flight:** `POST /api/payments/create-payment-intent` endpoint must exist on the backend (verify before launching).

**Risk note:** Mobile responsiveness of `<PaymentElement>` depends on Stripe's CSS — the PR should include a Playwright mobile snapshot test or manual verification.

---

## P5-018 — Payment confirmation flow to frontend

**Wave:** 5C (after 5B merges)
**Migration number reserved:** none
**Forbidden files:**
- `packages/api/src/payments/stripe-webhook-handler.ts` (do not touch webhook logic — only consume its events)
- `packages/shared/**`

**Allowed files:**
- `packages/web/src/components/customer/InvoicePaymentPage.tsx` (modify — add SSE/polling)
- `packages/web/src/hooks/useInvoiceStatus.ts` (new)
- `packages/api/src/routes/invoices.ts` (add SSE endpoint or polling-friendly status response)
- `packages/api/src/routes/invoices.test.ts` (modify)
- `packages/web/src/hooks/useInvoiceStatus.test.ts` (new)

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm run typecheck && \
  npm test --workspace=packages/api -- --run --grep "P5-018|invoice-status" && \
  npm test --workspace=packages/web -- --run --grep "P5-018|useInvoiceStatus"
```

**Pre-flight:** P5-016 merged.

**Risk note:** Avoid websockets in v1 (infra cost + Railway support); use SSE or 5-second polling. Either way, ensure the SSE/poll endpoint is tenant-scoped and view-token-gated for the public payment page (no auth required, but token must validate).

---

## P5-019 — Invoice delivery notification

**Wave:** 5B (parallel)
**Migration number reserved:** none
**Forbidden files:**
- `packages/api/src/notifications/delay-notifications.ts` (different domain; don't touch)
- `packages/shared/**`

**Allowed files:**
- `packages/api/src/invoices/invoice.ts` (modify — emit `invoice.issued` event on issue)
- `packages/api/src/notifications/invoice-notifications.ts` (new)
- `packages/api/src/notifications/invoice-notifications.test.ts` (new)
- `packages/api/src/proposals/handlers/issue-invoice.ts` (modify — call notifier after issue)

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run --grep "P5-019|invoice-notification|invoice-delivery"
```

**Pre-flight:** none (uses existing notification infrastructure).

**Risk note:** v1 = email only via existing SES/SMTP path (whichever is wired). SMS deferred to Phase 8 customer-followup agent. The invoice agent (Phase 9) will eventually own this; for now this story does the minimal direct send so v1 customers get their invoices.

---

## Universal pre-flight checks

Same as `p0-dispatch-addendum.md` § Universal pre-flight checks. Apply to every Phase 5 story before launching the dispatch agent.
