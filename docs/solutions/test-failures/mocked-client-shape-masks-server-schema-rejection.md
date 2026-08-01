---
title: "Mocked client tests asserting the request shape mask server Zod rejection (mobile create 400s)"
date: 2026-06-27
track: bug
problem_type: test-failures
module: "packages/mobile/src/api, packages/api/src/shared/contracts.ts"
tags: ["mocked-shape-trap", "client-server-contract", "line-items", "zod", "integer-cents", "mobile", "testing", "estimates", "invoices"]
related: ["docs/solutions/conventions/line-item-price-field-estimate-vs-invoice.md"]
---

## Problem
The mobile estimate/invoice create clients
(`packages/mobile/src/api/{estimates,invoices}.ts`) POSTed line items as
`{description, quantity, unitPriceCents, catalogItemId}`, but the server
`lineItemSchema` (`packages/api/src/shared/contracts.ts`) requires
`id`, `totalCents`, `sortOrder`, and `taxable` as **non-optional**. Every
mobile create therefore failed Zod validation with a 400 — yet the mobile
unit tests were green.

## Symptoms
- `createEstimate`/`createInvoice` throw `createEstimate: 400` at runtime against the real API.
- The mobile tests (`src/api/estimates.test.ts`, `invoices.test.ts`) pass — they mock the fetch client and assert the body the client *sends*, never that the server *accepts* it.
- A whole feature ("mobile estimate/invoice create") ships looking done while being 100% broken on the real server.

## What Didn't Work
- **Trusting green mobile unit tests.** They asserted `body.lineItems` `toEqual` the exact shape the mapper produced. Both the code and the test were written from the same wrong mental model of the contract, so they agreed with each other and the bug was invisible. This is the CLAUDE.md "tests that mock the DB/server are never the only proof" anti-pattern, applied to an HTTP contract.
- **Reading the create route handler.** The handler logic looked fine — the rejection happens earlier, at `schema.parse(req.body)`, before any handler code runs. You have to read the *schema*, not the handler.

## Solution
Synthesize the schema-required fields in a shared mapper and pin the contract
with an **api-side** test that runs the real Zod schema.

```ts
// packages/mobile/src/api/lineItems.ts (new) — one mapper, used by both clients
export function toServerLineItems(items: LineItem[]) {
  return items.map((li, i) => ({
    id: `li-${i + 1}`,
    description: li.description,
    quantity: li.quantity,
    unitPriceCents: li.unitPriceCents,
    totalCents: Math.round(li.unitPriceCents * li.quantity), // integer cents
    sortOrder: i,
    taxable: false,                                          // sheet has no per-line tax control
    ...(li.catalogItemId ? { catalogItemId: li.catalogItemId } : {}),
  }));
}
```

```ts
// packages/api/test/routes/mobile-create-line-item-contract.test.ts (new)
// Pins the REAL schema, not a mock: complete shape parses, old shape throws.
import { createEstimateSchema, createInvoiceSchema } from '../../src/shared/contracts';
expect(() => createEstimateSchema.parse({ jobId: 'j', lineItems: [complete] })).not.toThrow();
expect(() => createEstimateSchema.parse({ jobId: 'j', lineItems: [incomplete] })).toThrow();
```

## Why This Works
The bug is a client/server **contract** divergence. A mock-based client test
can only ever prove "the client sends what the test author thinks it should" —
it cannot prove the server accepts it, because the mock *is* the server. Running
the authoritative Zod schema in a test makes the real contract the oracle, so a
future drop of a required field fails the build instead of shipping a silent
400.

## Prevention
- When a client builds a request body for a typed/validated endpoint, the
  proof-of-correctness test must exercise the **real validator/schema** (import
  the Zod schema, or hit the route in an integration test) — not just assert the
  outgoing shape against a hand-written expectation.
- Treat HTTP request bodies like DB rows: the CLAUDE.md rule "tests that mock the
  DB are never the only proof a query works — pin real columns" applies equally
  to "pin the real schema fields."
- Prefer one shared mapper from the UI model to the contract shape, so the
  field-completeness fix lives in one place for all callers.
- Cross-reference: the field *names* on line items also differ by document type
  (estimates `unitPrice` vs invoices `unitPriceCents`) — see
  `docs/solutions/conventions/line-item-price-field-estimate-vs-invoice.md`.
