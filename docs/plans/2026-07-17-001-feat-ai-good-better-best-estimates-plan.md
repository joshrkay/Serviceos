# feat: AI-drafted good-better-best tiered estimates (EE-1)

**Created:** 2026-07-17
**Depth:** Standard
**Status:** plan

## Summary

Teach the two AI estimate-drafting handlers (`draft_estimate` voice/chat and the
MMS/photo handler) to emit **good-better-best tiered options** and **optional
add-ons** into the line-item schema that already exists. The entire downstream
stack — DB columns, proposal→estimate execution, billing/selection math, the
customer approval UI — already understands grouped/optional lines; only the AI
*emit* side is missing. This unlocks the highest close-rate lever in the category
(tiered options + one-tap upsells) with a near-AI-only change.

## Problem Frame

The good-better-best presentation stack is fully built and idle: line items carry
`groupKey`/`groupLabel`/`isOptional`/`isDefaultSelected`, the customer approval
page (`packages/web/src/components/customer/EstimateApprovalPage.tsx`) renders
tier radios + add-on checkboxes with live totals, and accept-time recompute
honors the customer's selection. But the AI drafting handlers only ever emit flat
line items, so a tiered estimate can only be hand-authored. Owners lose the
biggest close-rate driver unless they build tiers manually — which defeats the
voice-first, AI-drafted value proposition.

## Requirements

- **R1.** When a drafting request implies options ("good/better/best", "give them
  choices", "offer an upgrade"), the draft emits ≥2 mutually-exclusive tier lines
  sharing a `groupKey`, each catalog-grounded, with exactly one
  `isDefaultSelected`.
- **R2.** Optional upsell lines are emitted with `isOptional=true` and are **not**
  default-selected unless the request explicitly asks for them.
- **R3.** Every tier/add-on line remains catalog-grounded via the existing
  resolver; an uncatalogued tier still caps confidence and forces human review
  (money-safety invariant unbroken).
- **R4.** Grouped output is structurally well-formed at persistence: exactly one
  default per group, no singleton "groups", add-ons off-by-default — enforced by
  a deterministic normalizer (primary) and a Zod refine (backstop).
- **R5.** A tiered draft's owner-facing headline total reflects the **default
  selection**, not the sum of every tier + add-on.
- **R6.** The operator (the human approving an autonomous draft) can see the tier
  groups and add-ons in the proposal review card, not a flat list.
- **R7.** Flat (non-optioned) requests draft exactly as today — no behavior or
  prompt-path change when no options are implied.
- **R8.** Both the voice/chat (`draft_estimate`) and MMS/photo drafting paths
  support tiers.

## Key Technical Decisions

- **Request-triggered only for v1 (no proactive/unprompted tiering).** — The
  drafting LLM is blind to the tenant catalog (grounding is deterministic
  post-processing), so to offer tiers unprompted it must invent both the scope
  *and* price of the upsell tiers; those are precisely the lines most likely to
  be uncatalogued → capped → forced to review, which defeats the autonomy the
  proactive mode was meant to add. (Alternative — proactive tiering on
  replacement jobs — rejected for v1; the clean path is a v2 *catalog-aware*
  proactive mode that pre-resolves the primary line and injects its sibling
  catalog variants into the prompt so tiers are built from real items.)
- **Normalizer lives in `packages/api/src/shared/billing-engine.ts`, beside the
  existing tier helpers** (`resolveSelectedLineItems`, `validateLineItemSelection`,
  `defaultSelectionIds`) — it operates on the same tier vocabulary. (Alternative —
  a new module under `ai/resolution/` — rejected: it would split tier logic across
  two homes.)
- **Coercion primary, schema backstop.** The normalizer *coerces* malformed
  grouping (never rejects), because the drafting pipeline already tolerates LLM
  sloppiness (`buildPartialPayload`, grounding fallbacks) — a hard reject over a
  missing default flag would fail the entire estimate. The Zod `.superRefine` is a
  backstop for hand-built/future payloads that skip the normalizer. They must
  agree on the same fixtures or a strict refine would 400 a live draft.
- **Normalizer is flag-only: it never drops or reorders lines.** `lineItems[i]`
  indices must stay aligned across grounding → normalize →
  `lineItemConfidenceSignals` → clarification signals. A singleton group is
  demoted by clearing its `groupKey` (in place), never removed.
- **Refine on `draftEstimatePayloadSchema` at the array level, not on the shared
  per-line `lineItemSchema`.** — keeps `updateEstimatePayloadSchema` (edit
  actions) unaffected.
- **Default-selection headline totals fixed at the `createEstimate` seam** using
  the existing `resolveSelectedLineItems` — one source of truth; no-op when there
  are no selectable groups; also corrects manually-authored tiered estimates (a
  latent issue today).

## Scope Boundaries

**In scope:** AI emission of tiers/add-ons in both drafting handlers; a pure tier
normalizer; proposal-contract declaration + refine; default-selection headline
totals; operator-card grouped display.

**Non-goals:**
- Proactive/unprompted tiering (v2, catalog-aware).
- Consumer financing (deferred by product decision).
- Any schema/migration, execution-mapping, billing-selection, or customer-UI work
  — all already built.
- Assemblies (catalog item → labor+material components).
- Auto-resolving "grounding collapse" (two tiers resolving to the same catalog
  item) — see Open Questions; accepted as a human-reviewed limitation for v1.

### Deferred to follow-up work
- **v2 catalog-aware proactive mode** — pre-resolve the primary line, inject the
  matched item's sibling variants into the prompt so tiers ground cleanly, plus a
  proactive trigger heuristic and token-budget handling.
- **Grounding-collapse guard** — detect a group whose options all resolve to one
  `catalogItemId` and surface it distinctly (can't be flag-only, so out of v1).

## Repository invariants touched

- **Integer cents** — R5 totals use the existing `calculateDocumentTotals` /
  `resolveSelectedLineItems` helpers; no float introduced.
- **Catalog grounding** — every tier/add-on line flows through the unchanged
  `groundLineItemPricing`; uncatalogued tiers keep capping confidence at
  `UNCATALOGUED_CONFIDENCE_CAP` and set `requiresReview`. Intended consequence:
  tiered drafts auto-approve *less* often (more grounding surface) — correct
  money-safety trade, not a regression.
- **Human-approval gate** — drafts still never auto-execute; U6 makes the
  operator's review honest by showing the tier structure.
- **Zod proposals** — U2 declares the grouping fields and adds the structural
  refine.
- **Audit events** — estimate creation already emits audit; unchanged.
- **LLM gateway** — drafting already routes through the gateway; no new call path.

## Implementation Units

### U1. Pure tier-structure normalizer
- **Goal:** Deterministically coerce drafted line items into structurally-valid
  grouped output (exactly one default per group; add-ons off unless requested;
  singleton groups demoted; grouped options marked selectable) — flag-only, no
  drop/reorder.
- **Requirements:** R4 (and enables R1, R2).
- **Dependencies:** none.
- **Files:** `packages/api/src/shared/billing-engine.ts` (add
  `normalizeTierStructure`), `packages/api/src/shared/billing-engine.test.ts` (or
  the co-located tier-helper test file — mirror where `resolveSelectedLineItems`
  is tested).
- **Approach:** New pure function `normalizeTierStructure(lineItems, opts?)`
  beside `resolveSelectedLineItems`. For each non-null `groupKey` group: keep the
  first `isDefaultSelected===true`; if none, pick a deterministic default (lowest
  `sortOrder`); clear the flag on the rest; set `isOptional=true` on grouped
  options. For add-ons (`isOptional && !groupKey`): force `isDefaultSelected=false`
  unless an explicit `addOnsRequested` signal (from the handler) says otherwise.
  Demote a singleton group by clearing its `groupKey` in place. Returns a new
  array of the **same length and order** (map, not filter).
- **Patterns to follow:** the pure/deterministic style of
  `packages/api/src/ai/resolution/catalog-resolver.ts` and the existing tier
  helpers in `billing-engine.ts`.
- **Test scenarios:**
  - Happy path: two-option group with one flagged default → unchanged; three
    options with zero defaults → lowest-`sortOrder` becomes default, others
    cleared.
  - Edge cases: multiple defaults in one group → only first kept; singleton group
    → `groupKey` cleared, line preserved at same index; add-on with
    `isDefaultSelected=true` but `addOnsRequested=false` → forced false; empty
    array; no grouped lines → returned untouched.
  - Invariant: output length and per-index identity of non-grouping fields
    (`description`, `unitPrice`, `quantity`, `pricingSource`) are preserved
    (index-alignment guard).
- **Verification:** unit tests pass; a fixture with a deliberately malformed group
  comes out with exactly one default and identical array length/order.

### U2. Proposal contract: declare grouping fields + structural refine
- **Goal:** Make grouped drafted output explicitly valid (not merely surviving via
  non-stripping validation) and reject structurally-malformed groups as a backstop.
- **Requirements:** R4.
- **Dependencies:** none (independent of U1; they must agree on fixtures).
- **Files:** `packages/api/src/proposals/contracts.ts`,
  `packages/api/test/shared/contracts.test.ts` (or the proposals-contract test
  location the repo uses).
- **Approach:** Add `groupKey`/`groupLabel` (optional strings) and
  `isOptional`/`isDefaultSelected` (optional booleans) to the local
  `lineItemSchema` used by draft + edit payloads (mirror
  `packages/shared/src/contracts/money.ts:34-38`). Add a `.superRefine` **on
  `draftEstimatePayloadSchema` at the `lineItems` array level** asserting: each
  non-null `groupKey` group has ≥2 options and exactly one
  `isDefaultSelected===true`; `isDefaultSelected` appears only on selectable lines
  (grouped or `isOptional`). Do **not** attach the refine to the per-line schema or
  to `updateEstimatePayloadSchema`.
- **Patterns to follow:** existing schema definitions and any `.superRefine`
  usage already in `packages/api/src/proposals/contracts.ts`.
- **Test scenarios:**
  - Happy path: a valid tiered payload (2 options, one default) passes; a flat
    payload passes unchanged.
  - Error paths: group with two defaults → invalid; group with one option → invalid
    (should be a flat line); `isDefaultSelected` on an always-billed line → invalid.
  - Edit-path guard: an `update_estimate` payload with grouping fields is not
    subjected to the draft refine.
  - Agreement: the exact fixtures U1's normalizer produces all pass this refine
    (no coerce-vs-reject deadlock).
- **Test expectation:** pure contract unit tests; no integration test (no DB).

### U3. Wire `draft_estimate` (voice/chat) emission
- **Goal:** Turn the feature on for the primary handler — prompt guidance +
  normalizer call — while preserving grounding, confidence caps, clarification,
  and `_meta`.
- **Requirements:** R1, R2, R3, R5 (default flag), R7.
- **Dependencies:** U1, U2.
- **Files:** `packages/api/src/ai/tasks/estimate-task.ts`,
  `packages/api/test/ai/estimate-task.test.ts`.
- **Approach:** Extend `ESTIMATE_SYSTEM_PROMPT` to document the optional
  `groupKey`/`groupLabel`/`isOptional`/`isDefaultSelected` fields and the
  **request-only** emit policy (emit tiers only when the request implies options;
  tiers must be genuinely distinct scopes; flag exactly one default). Derive an
  `addOnsRequested` signal from the request in the handler. Call
  `normalizeTierStructure(payload.lineItems, { addOnsRequested })` **immediately
  after `groundLineItemPricing` and before** the confidence/clarification/`_meta`
  passes (so indices stay aligned and uncatalogued tiers still cap). Prices remain
  in the estimate `unitPrice` (integer cents) field — never `unitPriceCents`/
  `totalCents` (see `docs/solutions/conventions/line-item-price-field-estimate-vs-invoice.md`).
- **Patterns to follow:** the existing grounding→confidence→`_meta` sequence in
  `estimate-task.ts`; the mocked-gateway + `InMemoryCatalogItemRepository` test
  setup in `estimate-task.test.ts`.
- **Test scenarios:**
  - Happy path: an options-implying request with a catalog seeded for all tiers →
    payload has a `groupKey` group of ≥2 grounded lines, exactly one default; an
    `isOptional` add-on defaults off.
  - Grounding preserved: each tier line carries `pricingSource:'catalog'` when
    seeded; a tier absent from the catalog → `pricingSource:'uncatalogued'`,
    `confidenceScore ≤ UNCATALOGUED_CONFIDENCE_CAP`, `_meta.overallConfidence='low'`,
    `requiresReview` set.
  - Regression: a flat request produces byte-identical output to today (no
    grouping fields, same prompt path).
  - Estimate-shaped fixture: line prices asserted on `unitPrice` (integer cents),
    not `unitPriceCents`.
- **Verification:** handler tests pass; a seeded options request yields a
  well-formed tiered proposal; an uncatalogued tier is provably kept out of
  auto-approve.

### U4. MMS/photo handler parity
- **Goal:** Same tier/add-on emission for photo-sourced replacement quotes.
- **Requirements:** R8 (and R1–R3, R7 for the MMS path).
- **Dependencies:** U1, U2.
- **Files:** `packages/api/src/ai/tasks/mms-estimate-task.ts`,
  `packages/api/test/ai/tasks/mms-estimate-task.test.ts`.
- **Approach:** Apply the same prompt guidance to `MMS_ESTIMATE_SYSTEM_PROMPT` and
  the same `normalizeTierStructure` call after `groundLineItemPricing`. Preserve
  the MMS-specific behaviors (injected `customerId`, vision-parse safe-fallback
  result, no clarification loop). No shared grounding change.
- **Patterns to follow:** `mms-estimate-task.ts`'s existing grounding call and its
  `catalogWith([...])` / `failingGateway()` test helpers.
- **Test scenarios:**
  - Happy path: a vision JSON that includes tier options → grounded, normalized
    tiered payload with one default.
  - Uncatalogued tier from a photo → confidence cap + `_meta` marker (as U3).
  - Safe fallback: a vision-parse failure still returns the existing
    `{ status: 'parse_failed' }` shape (tiers don't change the failure path).
  - Regression: a flat photo estimate is unchanged.
- **Verification:** MMS handler tests pass; parity with U3 on grounding + caps.

### U5. Default-selection headline totals
- **Goal:** A tiered estimate's stored/owner-facing headline total reflects the
  default selection, not the sum of all tiers + add-ons.
- **Requirements:** R5.
- **Dependencies:** none in code (uses existing `resolveSelectedLineItems`); test
  realism benefits from U3.
- **Files:** `packages/api/src/estimates/estimate.ts` (`createEstimate` totals
  seam), an integration test under
  `packages/api/test/integration/` (Docker-gated).
- **Approach:** Where `createEstimate` computes
  `totals = calculateDocumentTotals(input.lineItems, …)`, resolve the default
  selection first when selectable items are present:
  `calculateDocumentTotals(resolveSelectedLineItems(input.lineItems), …)`. When
  there are no groups/optionals, `resolveSelectedLineItems` returns all items, so
  totals are byte-identical — no behavior change for flat estimates. All persisted
  line items (every tier/add-on) are still stored; only the headline `totals`
  changes.
- **Patterns to follow:** existing `calculateDocumentTotals` call site in
  `estimate.ts`; accept-time recompute in
  `packages/api/src/estimates/public-estimate-service.ts` (the same
  resolve-then-total shape).
- **Test scenarios:**
  - Happy path (integration, real Postgres): a tiered estimate persists with
    headline total = default tier + default-on add-ons (not the sum of all);
    every option row is still stored in `estimate_line_items`.
  - Regression (integration): a flat estimate's totals are identical to
    pre-change (pin the exact cents).
  - Edge: a group with no flagged default falls back consistently with U1's
    default pick; a 100%-discount / zero-total tiered estimate.
- **Verification:** integration test proves headline total = default selection and
  flat-estimate totals unchanged; real columns exercised (not a mocked Pool).

### U6. Operator review-card grouped display
- **Goal:** The human approving an autonomous tiered draft sees the tier groups
  and add-ons grouped, not a flat line list.
- **Requirements:** R6.
- **Dependencies:** U3 (needs tiered drafts to render).
- **Files:** `packages/web/src/components/shared/AIProposalCard.tsx`,
  `packages/web/src/components/shared/AIProposalCard.test.tsx`.
- **Approach:** In the draft_estimate rendering, group line items by `groupKey`
  (label from `groupLabel`), show each tier with its price and mark the default;
  list `isOptional` add-ons separately as optional. Read-only display — no
  selection control (the operator approves the menu; the customer selects). Honor
  the mobile UI contract (≥44px tap targets, no 320px overflow) since this card is
  used on mobile.
- **Patterns to follow:** the customer-side grouping in
  `packages/web/src/components/customer/EstimateApprovalPage.tsx` (tierGroups /
  addOns derivation) for the grouping logic; existing `AIProposalCard.tsx`
  rendering for style.
- **Test scenarios:**
  - Happy path: a proposal with a 3-option group + one add-on renders one group
    block (default marked) and the add-on as optional.
  - Regression: a flat proposal renders exactly as today.
  - Class-contract: tap-target / no-overflow classes present (jsdom
    class-contract test; mirror `e2e/estimate-approval-mobile.spec.ts` intent).
- **Test expectation:** jsdom component test; no Playwright required for v1 (the
  customer flow already has viewport coverage).

## Risks & Dependencies

- **Index alignment (sharpest edge).** The normalizer must be strictly flag-only;
  any drop/reorder mis-indexes `lineItems[i]` in confidence markers and
  clarification signals. Guarded by U1's length/order-preservation test.
- **Coerce-vs-reject deadlock.** If U2's refine is stricter than U1's coercion, a
  live draft 400s. Mitigated by testing both against the same fixtures (U2
  "agreement" scenario).
- **Grounding collapse.** Two distinct tiers that resolve to the same catalog item
  become identical-priced tiers. Accepted for v1 (prompt says tiers must be
  distinct; operator sees it in U6 and can reject/fix). See Open Questions.
- **Label erasure.** Grounding overwrites a line's `description` with the catalog
  item name; the good/better/best distinction then rides `groupLabel` + the
  distinct catalog items. Accepted display nuance.
- **Stricter auto-approval by design.** Tests must assert the cap firing on
  uncatalogued tiers is intended, not a regression.

## Open Questions (deferred to implementation)

- **Default-tier pick when the model flags none.** Plan uses lowest `sortOrder`;
  an alternative is the middle/"better" tier (classic upsell anchor). Decide at
  implementation with a quick eval — kept out of the plan to avoid baking in a
  sales-psychology choice prematurely.
- **Grounding-collapse handling.** Whether to add a (non-flag-only, hence
  out-of-v1) guard that surfaces a group whose options resolve to one
  `catalogItemId`. Revisit after observing real drafts.
- **Prompt phrasing / exact trigger cues.** The precise wording that reliably
  distinguishes an options-implying request from a flat one is an eval-tuning
  detail, not a planning decision.

## Sources & Research

- Codebase mapping (persistence, execution, billing, public view, tests) and
  strategy analysis via `Explore` + `Plan` sub-agents, 2026-07-17.
- `docs/solutions/conventions/line-item-price-field-estimate-vs-invoice.md` —
  estimate payloads use `unitPrice` (integer cents), not `unitPriceCents`/
  `totalCents`; tests must use estimate-shaped fixtures.
- `docs/competitive-analysis.md` — records good/better/best as already built
  except the AI-drafting emission.
- Prior story framing: `docs/stories/estimating-competitive-parity-stories.md`
  (EE-1).
