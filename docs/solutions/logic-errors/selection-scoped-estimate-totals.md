---
title: "Selection-scoped estimate totals: resolve the same selection at every derived-money site"
date: 2026-07-17
track: bug
problem_type: logic-errors
module: "packages/api/src/estimates, packages/api/src/shared/billing-engine, packages/api/src/routes/estimates.ts"
tags: ["estimates", "good-better-best", "billing", "money", "totals", "discount"]
related: ["docs/solutions/conventions/line-item-price-field-estimate-vs-invoice.md"]
---

## Problem

Good-better-best estimates persist **every** tier option and add-on as line
items, but the customer only pays for a **selection** (one option per tier group
+ any pre-checked add-ons + always-billed lines). The moment a document's
headline total is scoped to that default selection, every *other* money figure
derived from the line items must be scoped to the **same** selection — or the
figures disagree.

Two concrete bugs shipped from missing this:

1. **Re-inflation on edit.** The headline total was scoped to the default
   selection in `createEstimate` only. `updateEstimate`, `reviseEstimate`,
   `duplicateEstimate`, and the voice `estimate-editor` still summed *all*
   options, so a tiered estimate's total jumped back to the sum of every tier
   the instant it was edited/revised.
2. **Over-discount.** The REST route computed an auto membership discount from
   `parsed.lineItems.reduce(...)` over every option, then handed the absolute
   cents to `createEstimate`, which applied it to the *narrower* default
   subtotal. A 10% member discount on a $300 menu ($100 default tier + $200
   alternate) headlined at **$70 instead of $90**.

## Symptoms

- A tiered estimate shows the right total on create, then a larger total after
  any edit/revise/duplicate.
- A tiered estimate with a percentage discount headlines lower than expected
  (discount magnitude computed on the full menu, applied to the default subset).
- Flat estimates look fine, so the bug hides until someone builds a tiered one.

## What Didn't Work

- **Fixing only the obvious seam** (`createEstimate`). It felt complete because
  the create path is where tiered drafts first land, but totals are recomputed
  at four other sites and the discount base is computed in a route — all of
  which still summed everything. A special case on one seam is the tell that the
  fix is at the wrong altitude.

## Solution

Introduce one shared helper and use it at **every** estimate headline-total
site; base any percentage-derived figure on the same resolved selection.

```ts
// packages/api/src/shared/billing-engine.ts
export function calculateSelectedDocumentTotals(
  lineItems: LineItem[], discountCents: number, taxRateBps: number, processingFeeBps = 0,
): DocumentTotals {
  // resolveSelectedLineItems returns ALL items when there are no selectable
  // groups, so flat documents are byte-identical.
  return calculateDocumentTotals(
    resolveSelectedLineItems(lineItems), discountCents, taxRateBps, processingFeeBps,
  );
}
```

Then, at create / update / revise / duplicate / voice-edit:

```ts
// before
const totals = calculateDocumentTotals(lineItems, discountCents, taxRateBps);
// after
const totals = calculateSelectedDocumentTotals(lineItems, discountCents, taxRateBps);
```

And for the discount base (routes/estimates.ts):

```ts
// before — sums every tier option, then applied to the default subset
const subtotalCents = parsed.lineItems.reduce((s, li) => s + li.totalCents, 0);
// after — same subset the headline uses
const subtotalCents = resolveSelectedLineItems(parsed.lineItems)
  .reduce((s, li) => s + li.totalCents, 0);
```

The **accept path stays separate**: `public-estimate-service.approve()` resolves
the *customer's* chosen selection (`acceptedSelection`), not the default —
that's the one place a different selection is correct.

## Why This Works

`resolveSelectedLineItems(lineItems)` with no explicit ids returns the default
selection for a tiered document and *all* items for a flat one. Routing every
headline total and every percentage base through it makes "which lines count as
money" a single decision instead of N independent `reduce`/`calculateDocumentTotals`
call sites that silently drift apart.

## Prevention

- **One helper, every site.** Grep for `calculateDocumentTotals(` in the
  estimates domain before adding a new total; use `calculateSelectedDocumentTotals`
  for estimate *headline* totals. A raw `calculateDocumentTotals` over
  `estimate.lineItems` is a smell unless it's the accept path (which resolves
  the accepted selection explicitly).
- **The rule:** *a selection-scoped total means every derived money figure —
  discount base, tax base, any percentage — must resolve the same selection.*
- **Tests:** pin (a) a tiered estimate keeps its default-selection total after
  `updateEstimate`, and (b) a percentage discount on a tiered estimate is
  computed on the default subset — flat estimates unaffected. See
  `test/shared/billing-engine.test.ts`, `test/estimates/estimate.test.ts`, and
  `test/routes/estimates-member-pricing.route.test.ts`.
- **UI corollary (same class of bug):** a read-only surface that renders
  selectable lines must cover *every* container. The good-better-best inbox
  display first rendered only for standalone proposals and silently skipped
  chained ones (`ProposalChainCard`), so a tiered estimate in an autonomous
  voice-close chain showed no options to the approver. Extract the renderer and
  use it in every container, mirroring the "every site" rule above.
