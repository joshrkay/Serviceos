# INV-04 — Expose payment-link provider via HTTP

**Matrix row:** INV-04 (Invoices · payment link)
**Current predicted verdict:** fail (provider module exists, no HTTP route)
**Target verdict:** pass
**Effort:** S (< 2 hours)

## Problem

The payment-link provider module exists and is exercised by unit tests, but
there is no HTTP route that calls it. A customer-facing "pay this invoice"
link can't be produced without one.

## Evidence from code

- Provider module exists under `packages/api/src/invoices/payment-link*` or
  `packages/api/src/payments/*` (confirm during implementation).
- `packages/api/src/routes/invoices.ts:26-144` — no
  `POST /:id/payment-link` route present.

## Acceptance criteria

- [ ] `POST /api/invoices/:id/payment-link` is registered on the invoices router.
- [ ] Requires `invoices:update` permission.
- [ ] Only valid for invoices in status `open` or `partially_paid`. Returns
  `409` with a typed error for other statuses.
- [ ] Delegates to the existing provider; does not reimplement Stripe logic.
- [ ] Response: `{ url, expiresAt }` (URL is the hosted checkout link).
- [ ] Provider's returned link is also persisted on the invoice
  (`payment_link_url` + `payment_link_expires_at` columns if not present —
  include a migration if so).
- [ ] QA matrix `INV-04` flips from fail → pass; artifact shows 200 with a
  `url` that matches `^https://checkout\.stripe\.com/`.

## Allowed files

- `packages/api/src/routes/invoices.ts`
- `packages/api/src/invoices/invoice.ts` (thin wrapper calling provider)
- `packages/api/src/db/schema.ts` + new migration (if persistence columns missing)
- `packages/api/src/invoices/__tests__/*`

## Out of scope

- Rewriting the provider.
- Regenerating expired links automatically (document as follow-up).
- Surfacing the link in the web UI — that's a separate UI story.

## Verify

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
npm run test -w packages/api -- payment-link
npm run e2e:qa-matrix -- --grep INV-04
```
