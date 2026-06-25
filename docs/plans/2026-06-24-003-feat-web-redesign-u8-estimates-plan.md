# feat: Web redesign U8 — Estimates list + builder to Path A (recolor + kit migration)

**Created:** 2026-06-24
**Depth:** Deep
**Status:** plan

## Summary
Bring the Estimates cluster — list, the AI/manual builder, the shared line-item
and picker forms, and the convert sheets — onto the Path A brand, and migrate its
hand-rolled controls to the shared UI kit. This is the largest cluster yet
(~484 raw-palette occurrences across 8 files) and is **money-adjacent**: the
shared `LineItemEditor` is the single dollars→integer-cents component for both the
estimates and invoices builders. The work is sequenced coverage-first so the
untested money-affecting flows are pinned before they're touched.

## Problem Frame
The estimates screens hardcode the raw Tailwind palette (so the Path A token swap
doesn't reach them — see `docs/solutions/architecture-patterns/web-palette-to-token-class-migration.md`)
and the builder/forms are hand-rolled `<input>`/`<button>` markup inconsistent
with the rest of the app. Two files that carry money into other entities
(`NewEstimateFlow` → draft estimate, `ConvertToInvoiceSheet` → invoice) have **no
co-located tests**, so a structural migration there is unguarded. Affects every
operator creating or converting an estimate.

## Requirements
- R1. The estimates cluster + shared builder forms render on Path A — zero raw
  Tailwind palette in the touched files (grep-clean).
- R2. Categorical color maps collapse to calm tokens: `SVC_CHIP` and
  `CATEGORY_COLOR` → neutral; the indigo "Rivet AI" assistant bubble → primary.
- R3. Hand-rolled builder/forms (`NewEstimateFlow`, `LineItemEditor`,
  `CatalogPicker`, `CustomerPicker`) migrate to the kit (`Input`/`Button`, and
  `Field` where a labeled control exists), preserving accessible names and ≥44px
  (`min-h-11`) tap targets.
- R4. **Money integrity:** `LineItemEditor`'s dollars→cents conversion
  (`Math.round(dollars*100)`, `toLineItemPayload`, `totalCents`), the
  good-better-best `enableOptions` authoring, and `NewEstimateFlow`'s AI
  (`unitPrice`) vs catalog (`unitPriceCents`) dual-read are preserved
  byte-for-byte. No money re-flow.
- R5. Coverage-first: add characterization tests for the untested money-affecting
  flows (`NewEstimateFlow`, `ConvertToInvoiceSheet`) **before** migrating them.
- R6. No regressions in estimates **or invoices** (shared forms ripple to both);
  the full web suite stays green.

## Key Technical Decisions
- **Recolor AND migrate to the kit** — *(user-confirmed)*. Unlike a pure recolor,
  this swaps the hand-rolled controls for `Input`/`Button`. The added risk
  (money-adjacent, partly untested) is bought down by R5's coverage-first
  sequencing and by isolating the money component in its own unit.
- **Preserve `aria-label` keys through the kit swap** — the row inputs use
  `aria-label={`description-${index}`}`/`unit-price-${index}`; keep them on the
  kit `Input` so the existing `getByLabelText(...)` money tests stay green with no
  churn (see `docs/solutions/conventions/preserve-aria-label-through-kit-form-migration.md`).
  The compact grid inputs have no visible per-cell label (the column header is the
  label), so they take the kit `Input` directly — **not** wrapped in `Field`.
- **Native checkboxes stay native, recolored.** The kit exports no `Checkbox`
  (only `Input`/`Select`/`Textarea`/`Field`/`Button`/…). The GBB `optional`/
  `default-selected` checkboxes remain `<input type="checkbox">` with an
  `accent-primary` token, not a kit component.
- **Bespoke selection cards stay custom (recolored), not kit `Button`s.**
  `NewEstimateFlow`'s large option/step cards (~37 buttons) aren't a fit for the
  kit `Button` size system; migrate the real form inputs + standard action
  buttons to the kit and recolor the bespoke cards. Avoids forcing the kit where
  it distorts the layout.
- **Isolate the money component.** `LineItemEditor` gets its own unit (U8b) so the
  cents-critical diff is small and reviewable, and its ripple to invoices is
  verified in isolation before the bigger builder unit.
- **Categorical maps collapse, don't translate.** `SVC_CHIP` (service type) and
  `CATEGORY_COLOR` (labor/material/…) are categories, not statuses → one neutral
  token each; icon/label carries the distinction (same call as U7a / StatusBadge).

## Scope Boundaries
**In scope:** recolor + kit migration of `EstimatesPage`, `EstimateForm`,
`NewEstimateFlow`, `EstimateCreate`, `LineItemEditor`, `CatalogPicker`,
`CustomerPicker`, `ConvertToInvoiceSheet`, `ConvertToJobSheet`; new
characterization tests for `NewEstimateFlow` and `ConvertToInvoiceSheet`.

**Non-goals:**
- No change to money math, the cents conversion, GBB grouping semantics, or the
  AI/catalog dual-read — presentation/structure only.
- No API/contract/proposal-payload changes.
- No humanizing of existing labels or copy.

### Deferred to follow-up work
- A kit `Checkbox` component (would let the GBB checkboxes drop `accent-primary`).
- Re-flowing the GBB option-grouping UX (this unit only recolors it).
- `pages/estimates/EstimateCreate.tsx` is already token-clean (0 palette) — only
  re-verified, not restyled.

## Repository invariants touched
- **Integer cents (central):** `LineItemEditor` is the dollars→cents boundary
  (`Math.round(safeDollars*100)`); U8b changes only the *presentation* of the
  `unitPriceDollars` text input, never the conversion, `toLineItemPayload`, or
  `totalCents`. Convert sheets carry existing cents through unchanged.
- **Human-approval gate / proposals:** `NewEstimateFlow`'s AI path produces a
  reviewable draft, never an auto-executed estimate; the migration is visual and
  does not alter that flow.
- **Catalog grounding:** the catalog path sources `unitPriceCents` from the tenant
  catalog via `CatalogPicker`/`catalogToLineItem`; U8c preserves that mapping.
- RLS/tenant_id, audit events, LLM gateway, entity resolver: not touched (no
  server or data-path changes).

## Implementation Units

### U8a. Estimates list recolor
- **Goal:** Re-brand the estimates list + the (already kit-based) `EstimateForm`.
- **Requirements:** R1, R2
- **Dependencies:** U2, U4 (both landed)
- **Files:** `packages/web/src/components/estimates/EstimatesPage.tsx` (~192),
  `packages/web/src/components/estimates/EstimateForm.tsx` (~13),
  `packages/web/src/components/estimates/EstimatesPage.test.tsx` (extend).
- **Approach:** Apply the ordered token map (per the migration solution doc); list
  rows → description + amount + `StatusBadge` (mirror mobile). `EstimateForm`
  already imports the kit — recolor its inline palette only. Collapse any
  service/category chips on the list to the neutral token.
- **Patterns to follow:** U7a customers recolor (`14d915dc`); `StatusBadge`;
  the collision-ordered sed map.
- **Test scenarios:**
  - Existing `EstimatesPage.test.tsx` behavior stays green (no color coupling).
  - Add a Path A class-contract guard: render the list, assert
    `container.innerHTML` has no raw palette; a list-row status renders via the
    `StatusBadge` tone token.
- **Verification:** grep-clean of both files; `tsc --noEmit` clean; estimates
  tests green.

### U8b. LineItemEditor → kit + recolor (money component)
- **Goal:** Migrate the shared line-item editor's controls to the kit and recolor
  it, preserving the cents math exactly.
- **Requirements:** R1, R3, R4, R6
- **Dependencies:** U2
- **Files:** `packages/web/src/components/forms/LineItemEditor.tsx`,
  `packages/web/src/components/forms/__tests__/LineItemEditor.test.tsx` (extend).
- **Approach:** Swap each row `<input className={inputCls}>` (description, quantity,
  unit-price, tier-group) → kit `Input`, **keeping** the `aria-label`,
  `inputMode`, `placeholder`, and grid `col-span-*` (via `className`) and adding
  `min-h-11`. Add-row and remove (`×`) `<button>` → kit `Button`
  (`variant="outline"`/`"ghost"`, `size="sm"`, preserve `aria-label`). GBB
  checkboxes stay native, recolored `accent-primary`. Recolor totals/labels
  (`text-slate-700`→`text-foreground`, `border-slate-100/200`→`border-border`).
  **Do not touch** `toLineItemPayload`, `totalCents`, `emptyDraft`, or the
  per-line `Math.round` total. Remove the dead `inputCls` const.
- **Patterns to follow:** U7b kit-form migration (`69e6a50c`) + its solution doc
  (aria-label preservation); the kit `Input`/`Button`.
- **Test scenarios:**
  - Existing money tests stay green: `Math.round` dollars→cents, negative/NaN
    quantity → 0 (`toLineItemPayload`/`totalCents`), the GBB `enableOptions`
    payload (`groupKey`/`groupLabel`/`isOptional`/`isDefaultSelected`).
  - Edit via the kit inputs still updates drafts: typing into
    `getByLabelText('unit-price-0')` updates the cents output / line total.
  - Kit-semantics: a row input and the Add-row button carry `min-h-11`; the
    remove button keeps `aria-label='remove-line-0'`.
- **Verification:** grep-clean; LineItemEditor tests green; **full web suite**
  green (proves the invoices builder that also renders this component is
  unaffected); `tsc --noEmit` clean.

### U8c. Shared pickers → kit + recolor
- **Goal:** Migrate `CatalogPicker` and `CustomerPicker` to the kit and recolor.
- **Requirements:** R1, R3, R6
- **Dependencies:** U2
- **Files:** `packages/web/src/components/forms/CatalogPicker.tsx` (~12),
  `packages/web/src/components/forms/CustomerPicker.tsx` (~5),
  `packages/web/src/components/forms/CatalogPicker.test.tsx`,
  `packages/web/src/components/forms/__tests__/CustomerPicker.test.tsx` (extend).
- **Approach:** Search `<input>` → kit `Input` (preserve `aria-label`/placeholder,
  add `min-h-11`); trigger/result `<button>`s → kit `Button`; recolor result rows.
- **Patterns to follow:** U7b; kit `Input`/`Button`.
- **Test scenarios:** existing picker tests stay green (search filters, pick
  appends a catalog draft / selects a customer); add a `min-h-11` assertion on the
  search input.
- **Verification:** grep-clean; picker tests green; full web suite green.

### U8d. NewEstimateFlow characterization test (coverage-first, no recolor)
- **Goal:** Pin the builder's money-affecting behavior on the *current* code so
  the U8e migration is provably behavior-preserving.
- **Requirements:** R5
- **Dependencies:** none (runs against current `NewEstimateFlow`)
- **Files:** `packages/web/src/components/estimates/__tests__/NewEstimateFlow.test.tsx` (new).
- **Approach:** Render the flow and exercise the assembly path that produces line
  items, asserting the emitted payload uses **integer `unitPriceCents`** via
  `Math.round`; cover the GBB option grouping and both source paths — the AI path
  (estimate-shaped `unitPrice`) and the catalog path (`unitPriceCents`) — so the
  dual-read is locked before the refactor. Mock the gateway/api per existing
  estimate test patterns.
- **Patterns to follow:** `pages/estimates/__tests__/EstimateCreate.test.tsx`
  (asserts `unitPriceCents`); `components/forms/__tests__/LineItemEditor.test.tsx`.
- **Test scenarios:** happy path (build → payload has `unitPriceCents` integers);
  GBB option rows carry `groupKey`/`isOptional`; AI vs catalog rows both resolve
  to integer cents. Commit this **before** U8e so it passes on the old markup.
- **Verification:** new test passes against the unmodified `NewEstimateFlow`.

### U8e. NewEstimateFlow + EstimateCreate → kit + recolor (the builder)
- **Goal:** Re-brand and kit-migrate the builder, guarded by U8d.
- **Requirements:** R1, R2, R3, R4
- **Dependencies:** U8d (characterization must be green first)
- **Files:** `packages/web/src/components/estimates/NewEstimateFlow.tsx` (~203),
  `packages/web/src/pages/estimates/EstimateCreate.tsx` (0 — re-verify compose),
  `packages/web/src/components/estimates/__tests__/NewEstimateFlow.test.tsx` (extend).
- **Approach:** `SVC_CHIP` and `CATEGORY_COLOR` → neutral token; the indigo "Rivet
  AI" bubble (`bg-indigo-50`/`text-indigo-900`/`bg-indigo-600`…) → primary tints
  (`bg-primary/10`, `text-foreground`, `bg-primary`); migrate the 9 form
  `<input>`s → kit `Input` (preserve any `aria-label`) and standard action
  buttons → kit `Button`; leave bespoke option/step **cards** as recolored custom
  elements. Keep every assembly/branching path identical (U8d guards it).
- **Patterns to follow:** U8d test; U7a/U7b; the migration + aria-label solution
  docs.
- **Test scenarios:** U8d's characterization test stays green (behavior
  preserved); add a class-contract guard (no raw palette in the rendered flow;
  `SVC_CHIP`/`CATEGORY_COLOR` use the neutral token).
- **Verification:** grep-clean of both files; U8d + new guard green; full web
  suite green; `tsc --noEmit` clean.

### U8f. Convert sheets → coverage + kit + recolor
- **Goal:** Re-brand and kit-migrate the convert-to-invoice/job sheets, covering
  the untested converter first.
- **Requirements:** R1, R3, R5, R6
- **Dependencies:** U8b (the converters surface line items / totals)
- **Files:** `packages/web/src/components/estimates/ConvertToInvoiceSheet.tsx` (~25),
  `packages/web/src/components/estimates/ConvertToJobSheet.tsx` (~22),
  `packages/web/src/components/estimates/ConvertToInvoiceSheet.test.tsx` (new),
  `packages/web/src/components/estimates/ConvertToJobSheet.test.tsx` (existing).
- **Approach:** First add a `ConvertToInvoiceSheet` characterization test (it
  carries the estimate's cents into the new invoice — pin the totals/POST body),
  committed before the recolor. Then recolor both sheets and migrate their inputs/
  buttons to the kit. `ConvertToJobSheet` is guarded by its existing test.
- **Patterns to follow:** `ConvertToJobSheet.test.tsx`; U7b kit migration.
- **Test scenarios:** new converter test pins the cents carried into the invoice
  POST (integer cents, no float drift); both sheets' existing/added behavior stays
  green; class-contract guard (no raw palette).
- **Verification:** grep-clean of both files; converter tests green; full web
  suite green; `tsc --noEmit` clean.

## Risks & Dependencies
- **Money drift (highest).** Any change to `LineItemEditor`'s conversion would
  silently corrupt estimate/invoice totals. Mitigation: U8b touches only
  presentation; the cents functions are untouched and pinned by existing tests;
  full-suite run proves the invoices builder is unaffected.
- **Unguarded refactor.** `NewEstimateFlow`/`ConvertToInvoiceSheet` have no tests.
  Mitigation: R5 coverage-first (U8d, U8f) lands characterization tests on the old
  code before the migration commit.
- **Shared-form ripple.** `LineItemEditor`/`CatalogPicker`/`CustomerPicker` render
  in the invoices builder too (U9). Mitigation: U8b/U8c verify the **full** web
  suite, not just estimates.

## Open Questions (deferred to implementation)
- Exact `aria-label`/test-query surface of `NewEstimateFlow` and
  `ConvertToInvoiceSheet` (no tests today) — discovered when writing U8d/U8f.
- Whether `CATEGORY_COLOR` is also consumed outside `NewEstimateFlow` (grep at
  implementation; if shared, collapse at the source).
- Final kit `Button` variant per builder action (primary vs outline) — a visual
  call made against the rendered flow.

## Sources & Research
- `docs/solutions/architecture-patterns/web-palette-to-token-class-migration.md`
  (collision-ordered token map, categorical-map collapse).
- `docs/solutions/conventions/preserve-aria-label-through-kit-form-migration.md`
  (aria-label preservation, single-`role=alert`, `min-h-11`).
- Master plan U8 entry in `docs/plans/2026-06-24-001-feat-web-redesign-path-a-plan.md`
  (price-field gotcha is in proposal editors, not these create forms).
