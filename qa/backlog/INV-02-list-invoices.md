# INV-02 — Add `GET /api/invoices` list endpoint

**Matrix row:** INV-02 (Invoices · list for tenant)
**Current predicted verdict:** fail (no route → 404)
**Target verdict:** pass
**Effort:** M (2–3 hours)

## Problem

There is no bulk list endpoint for invoices. The web app's invoice list view
cannot paginate server-side, and the matrix's INV-02 row can only record a
404 as evidence.

## Evidence from code

- `packages/api/src/routes/invoices.ts:26-144` — registers
  `POST /`, `GET /:id`, `PUT /:id`, `POST /:id/issue`, `POST /:id/transition`.
  No `router.get('/', ...)`.
- Estimates router also lacks a list route; a similar pattern will work here
  but **don't** add it to estimates in this story — keep scope tight.
- Row definition in `e2e/qa-matrix/matrix.ts` (INV-02).

## Acceptance criteria

- [ ] `GET /api/invoices` returns the calling tenant's invoices, newest first.
- [ ] Query params supported (all optional):
  - `status` — one of the enum values (`draft|open|partially_paid|paid|void|canceled`)
  - `customerId` — uuid
  - `limit` — integer, default 25, max 100
  - `cursor` — opaque string for pagination (created_at + id based)
- [ ] Response shape:
  ```json
  { "items": [...InvoiceSummary], "nextCursor": "..." | null }
  ```
  `InvoiceSummary` includes `id`, `number`, `status`, `customerId`,
  `totalCents`, `issuedAt`, `dueDate`, `createdAt`. No line items (keep it light).
- [ ] RLS enforced: Tenant B token cannot see Tenant A's invoices (covered by
  existing ownership middleware).
- [ ] Requires `invoices:view` permission.
- [ ] QA matrix `INV-02` flips from fail → pass; artifact shows 200 with a
  non-empty `items` array seeded by prior rows.

## Allowed files

- `packages/api/src/routes/invoices.ts` (add route)
- `packages/api/src/invoices/invoice.ts` or new `invoice-list.ts` (add repo fn)
- `packages/api/src/invoices/__tests__/*` (unit test)
- `packages/shared/src/invoices.ts` (add `InvoiceSummary` contract if shared)
- `packages/web/src/invoices/*` is **not** in scope — don't touch the UI here.

## Out of scope

- Search by free-text.
- Full-object listing (return summaries only).
- Cursor-less offset pagination (use keyset on `(created_at, id)`).

## Verify

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
npm run test -w packages/api -- invoices
npm run e2e:qa-matrix -- --grep INV-02
```
