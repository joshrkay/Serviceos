---
title: "Line-item price fields differ by document: estimates use `unitPrice`, invoices use `unitPriceCents`"
date: 2026-06-15
track: knowledge
problem_type: conventions
module: "packages/api/src/proposals, packages/api/src/ai/resolution/catalog-resolver.ts, packages/api/src/learning/corrections, packages/api/src/ai/evaluation/invoice-edit-delta.ts, packages/api/src/shared/billing-engine.ts"
tags: ["line-items", "pricing", "integer-cents", "estimates", "invoices", "catalog-resolver", "mocked-shape-trap", "testing", "proposals"]
related: []
---

## Context
Money is always integer cents — but the field NAME that carries those cents on a
line item is NOT uniform across documents:

- **Estimate** proposal payloads carry the per-unit price in **`unitPrice`**
  (integer cents, despite the name) and have **no per-line total**. See
  `estimate-task.ts` (`applyCatalogPricing(lineItems, resolutions, 'unitPrice')`).
- **Invoice** proposal payloads (and the canonical `LineItem` in
  `shared/billing-engine.ts`) carry it in **`unitPriceCents`** plus a recomputed
  **`totalCents`**. See `invoice-task.ts` (`applyCatalogPricing(..., 'unitPriceCents')`).

`applyCatalogPricing` already takes the price field as an explicit `priceField`
parameter for exactly this reason. The `LineItem` TypeScript type only declares
`unitPriceCents`, so estimate line items flow through code as `LineItem` via a
**structurally-wrong cast** (`payload.lineItems as LineItem[]`) — TS will NOT
catch a `unitPrice`/`unitPriceCents` mismatch.

Any code that reads or writes a line price across BOTH document types must pick
or normalize the field; assuming `unitPriceCents` silently breaks the estimate
path, which is the more common case for things like labor-rate edits.

## Guidance
When new code touches line-item prices and can see both estimates and invoices:

1. **Reading for a diff/extractor** — normalize first: map each line to expose
   `unitPriceCents = line.unitPriceCents ?? line.unitPrice` before comparing.
   `computeInvoiceDeltas` only diffs `unitPriceCents`, so an unnormalized
   estimate edit produces zero deltas.
2. **Writing a resolved/edited price** — pick the field by CONTRACT, not by
   "which field happens to be present" (a price-less ambiguous line has
   neither). Infer from sibling lines (`lineItems.some(li => 'unitPriceCents' in li)`)
   and fall back to the proposal type (`/invoice/.test(proposalType)`), then
   recompute `totalCents` only on the invoice path.
3. **Never** rely on `'unitPriceCents' in line` alone — it is false for both
   estimate lines and price-less invoice lines.

## Why This Matters
Two distinct bugs in the same batch (Jun 2026) traced to this one split, and
**both passed their unit/integration tests** because the fixtures used
`unitPriceCents` — the precise "mocks that mislead" trap CLAUDE.md warns about
("tests that mock the DB are never the only proof"):

- `resolve-line.ts` stamped a resolved catalog price onto `unitPrice` for a
  price-less **invoice** line; the executor reads `unitPriceCents`, so the line
  shipped unpriced.
- `record-on-execution.ts` (correction-lesson loop) fed estimate lines
  (`unitPrice`) straight into `computeInvoiceDeltas` (reads `unitPriceCents`) →
  no `price_changed` delta → no labor-rate lesson. The feature was inert for
  estimates — exactly where labor-rate corrections happen.

## When to Apply
Any time you add code under `proposals/`, `ai/resolution/`, `ai/evaluation/`,
or `learning/corrections/` that reads or writes a line-item price and isn't
scoped to a single known document type. Also when writing tests for such code:
include an **estimate-shaped fixture (`unitPrice`)**, not just `unitPriceCents`,
or the test will green-light the broken estimate path.

## Examples
Reading (normalize for a diff):
```ts
// BEFORE — estimate edits invisible (unitPriceCents is undefined on both sides)
const deltas = computeInvoiceDeltas({ lineItems: drafted }, { lineItems: executed });

// AFTER — surface cents under unitPriceCents regardless of source contract
const norm = (items) => items.map((li) => {
  const cents = typeof li.unitPriceCents === 'number' ? li.unitPriceCents : li.unitPrice;
  return cents !== undefined ? { ...li, unitPriceCents: cents } : li;
});
const deltas = computeInvoiceDeltas({ lineItems: norm(drafted) }, { lineItems: norm(executed) });
```

Writing (pick field by contract):
```ts
// BEFORE — writes to the wrong field for a price-less invoice line
const priceField = 'unitPriceCents' in line ? 'unitPriceCents' : 'unitPrice';

// AFTER — sibling lines + proposal type decide the contract
const usesCents =
  'unitPriceCents' in line ||
  lineItems.some((li) => li && typeof li === 'object' && 'unitPriceCents' in li) ||
  /invoice/.test(proposal.proposalType);
const priceField = usesCents ? 'unitPriceCents' : 'unitPrice';
if (priceField === 'unitPriceCents') line.totalCents = Math.round(price * qty);
```
