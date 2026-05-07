# INV-03 — Deliver invoice on issue (email/SMS)

**Matrix row:** INV-03 (Invoices · send to customer)
**Current predicted verdict:** partial (status transitions, no delivery)
**Target verdict:** pass
**Effort:** M (3–5 hours)

## Problem

`POST /api/invoices/:id/issue` flips status `draft → open` and sets
`issuedAt`/`dueDate`, but nothing is actually sent to the customer. No email,
no SMS, no audit trail of "invoice delivered". The matrix row can't prove
customer delivery and is recorded as partial.

## Evidence from code

- `packages/api/src/invoices/invoice.ts:173-195` — `issueInvoice()` mutates
  state only. No call to any notification/mailer service.
- Status enum stays `open` (not `sent`) per
  `packages/api/src/db/schema.ts:564`. **Keep it that way** — product standard.

## Decision — preserve `open` status

We will **not** introduce a `sent` status. `open` means "issued and awaiting
payment". Delivery is an effect of issuing, not a separate state. Update
`qa/README.md` matrix note if needed.

## Acceptance criteria

- [ ] `POST /api/invoices/:id/issue` triggers async delivery via the shared
  worker pattern (P0-009). Synchronous response is unchanged.
- [ ] Delivery job emits one email (primary path) and falls back to SMS if the
  customer has no email on file but has a phone.
- [ ] Delivery result recorded in a new `invoice_deliveries` table:
  `(id, invoice_id, tenant_id, channel, recipient, status, error, created_at)`.
  One row per attempt.
- [ ] If delivery fails (bounced email, invalid phone), the invoice stays
  `open` but an audit event `invoice.delivery_failed` is emitted.
- [ ] Email template includes: tenant name, invoice number, total, due date,
  payment link (if INV-04 is shipped) or a plain "contact us to pay" sentence.
- [ ] Integration test with a fake mailer asserts one delivery row is written
  and the invoice status is `open`.
- [ ] QA matrix `INV-03` flips from partial → pass; artifact shows 200 on
  issue + a row in `invoice_deliveries`.

## Allowed files

- `packages/api/src/invoices/invoice.ts` (enqueue job after status flip)
- `packages/api/src/invoices/invoice-delivery.ts` (new job handler)
- `packages/api/src/db/schema.ts` (new table — include a migration)
- `packages/api/src/db/migrations/<next>.sql` (new)
- `packages/api/src/invoices/__tests__/*`

## Out of scope

- Dedicated `POST /:id/send` endpoint. Delivery is a side-effect of `issue`.
- Retry backoff tuning. Use the worker pattern's defaults.
- Customer preference for channel (email vs SMS). Default to email, fall back
  to SMS.

## Verify

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
npm run test -w packages/api -- invoice-delivery
npm run e2e:qa-matrix -- --grep INV-03
```
