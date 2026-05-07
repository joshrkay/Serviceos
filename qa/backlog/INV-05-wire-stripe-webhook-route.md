# INV-05 — Wire `POST /webhooks/stripe` route

**Matrix row:** INV-05 (Invoices · Stripe webhook updates status)
**Also flips:** INV-06 (idempotency) from predicted-partial → pass
**Current predicted verdict:** fail (handler exists, no route)
**Target verdict:** pass
**Effort:** S (< 2 hours)

## Problem

`handleStripeWebhook()` exists and has DB-backed idempotency via
`WebhookRepository`, but no Express route delivers requests to it. Stripe POSTs
to `/webhooks/stripe` hit a 404. The handler is unreachable in production.

## Evidence from code

- `packages/api/src/payments/stripe-webhook-handler.ts:63-114` — handler
  implemented, signature-verifying, idempotent.
- `packages/api/src/webhooks/routes.ts:30` — only `POST /webhooks/clerk`
  registered in `createWebhookRouter()`.
- `packages/api/src/app.ts:85` — `PgWebhookRepository` already bound, so
  idempotency is DB-backed the moment the route exists.

## Acceptance criteria

- [ ] `POST /webhooks/stripe` registered in `createWebhookRouter()`.
- [ ] Route uses the existing webhook base (P0-014) for signature verification
  using `STRIPE_WEBHOOK_SECRET` (env var; fail-fast if missing).
- [ ] Raw body preserved for signature check (do not parse JSON before verify).
- [ ] Returns `200` quickly; heavy work stays inside `handleStripeWebhook()`.
- [ ] Duplicate POST with same event id returns `200` without re-processing
  (idempotency from `WebhookRepository`).
- [ ] On `payment_intent.succeeded`, the linked invoice transitions to `paid`
  (or `partially_paid` if amount < total). **Confirm this transition already
  exists in the handler — if not, fix it in scope here.**
- [ ] Integration test posts a synthetic event twice and asserts one DB state
  change, two `webhook_events` rows (or whatever `WebhookRepository` persists).
- [ ] QA matrix `INV-05` flips from fail → pass, `INV-06` from partial → pass.

## Allowed files

- `packages/api/src/webhooks/routes.ts`
- `packages/api/src/payments/stripe-webhook-handler.ts` (only if the status
  transition is missing)
- `packages/api/src/app.ts` (only if env wiring needed)
- `packages/api/src/payments/__tests__/*`

## Out of scope

- Other Stripe events (refunds, disputes). Only `payment_intent.succeeded` +
  `charge.refunded` if trivially supported; otherwise log-and-acknowledge.
- Webhook replay tooling.

## Verify

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
npm run test -w packages/api -- stripe-webhook
# Local Stripe CLI replay:
stripe listen --forward-to http://localhost:3000/webhooks/stripe
stripe trigger payment_intent.succeeded
npm run e2e:qa-matrix -- --grep "INV-0[56]"
```
