# Estimating — Competitive Parity & Best-in-Class Stories

**Date:** 2026-07-17
**Origin:** Competitor research on Jobber and ServiceTitan estimating (branch
`claude/competitor-estimating-research-n5q02b`).
**Goal:** Make the estimating experience best-in-class.

---

## 1. Research context (condensed)

Deep-research pass on how Jobber and ServiceTitan run the estimate/quote flow.
Confidence is labelled honestly because most competitor pages block automated
fetching, so only one claim cluster survived adversarial verification.

- **✅ Adversarially verified — ServiceTitan integrated financing.** Financing is
  presented *inside* the estimate at point of sale; the quote auto-computes an
  "as-low-as" monthly payment; it is a multi-lender waterfall, not one bank.
  ServiceTitan self-reports ~16% higher average ticket for financing users
  (vendor benchmark, selection-bias caveat). **Deferred by product decision —
  see §4. Not scoped here.**
- **Category pattern (product knowledge, not independently re-verified this
  pass).** Both tools win the *close* at the **presentation layer**, not the
  creation layer:
  - **ServiceTitan:** good-better-best tiered options ("Presenting Options"),
    visual proposals with equipment photos, deep pricebook with cost buildups /
    margin discipline.
  - **Jobber:** optional line items the customer checks/unchecks (lightweight
    upsell), online approval + e-sign, automated quote follow-ups, deposits.

**Strategic read:** our wedge (voice + AI drafting + catalog-grounded pricing +
approval gate) already beats both on *creation speed*. To be best-in-class we
must also own the *presentation/close* layer. The good news from the codebase
audit below: most of that layer is already built — it's just not wired to the AI.

---

## 2. Codebase audit — what already exists

The presentation stack is substantially shipped:

| Capability | Status | Where |
|---|---|---|
| Good-better-best **data model** (mutually-exclusive tiers + optional add-ons) | ✅ Built | `groupKey`/`groupLabel`/`isOptional`/`isDefaultSelected` on `lineItemSchema` (`packages/shared/src/contracts/money.ts`); `acceptedSelection` on `estimateSchema` (`packages/shared/src/contracts/estimate.ts`) |
| Customer-facing **tier/add-on selection UX** (radios + checkboxes, seeded defaults, live preview total mirroring the billing engine, server recompute on accept) | ✅ Built | `packages/web/src/components/customer/EstimateApprovalPage.tsx` (`tierGroups`, `selectTier`, `toggleAddOn`, `hasSelectableItems`) |
| **Online approval + e-signature + view tracking** | ✅ Built | `viewToken`, `acceptedSignatureData`/`acceptedByName`/`acceptedByIp`, `firstViewedAt`/`viewCount` on `estimateSchema` |
| **Automated follow-up** (sweeps sent-but-unanswered estimates, re-sends, caps, stops on view/accept/reject, audited) | ✅ Built (single-touch) | `packages/api/src/workers/estimate-reminder-worker.ts` (default `reminderAfterDays=3`, `maxReminders=1`), `estimate-expiry-worker.ts` |
| **Catalog-grounded pricing** with confidence caps + hard `requiresReview` gate on AI-invented prices | ✅ Built | `packages/api/src/ai/resolution/catalog-resolver.ts` |

### The gaps (this is the whole list)

1. **The AI never drafts tiers or add-ons.** `draft_estimate`'s prompt asks the
   LLM only for flat `{description, quantity, unitPrice, category}`
   (`packages/api/src/ai/tasks/estimate-task.ts`). So the entire good-better-best
   selection stack sits idle unless a human hand-authors tier groups. **Highest
   leverage, lowest cost — the infrastructure is already there.**
2. **Catalog items carry no cost.** `CatalogItem` has `unitPriceCents` but no
   cost (`packages/api/src/catalog/catalog-item.ts`), so margin protection is
   impossible today.
3. **Catalog items carry no image**, so proposals can't show equipment photos.
4. **Follow-up is single-touch** (one reminder, SMS only) — a real feature, but
   thinner than Jobber's multi-touch cadence.
5. **No assemblies** (a catalog item that expands into labour + materials).
   `estimates/bundle-patterns.ts` is a *learning* signal, not an assembly model.

---

## 3. Stories

Sizing per `docs/PRD-execution-catalog.md` policy (XS/S only; M+ must be split).
IDs use an `EE-` (Estimating Experience) prefix; they map onto Phase 2 (proposal
AI) and Phase 4 (estimate intelligence).

**Recommended sequence:** EE-1 first (biggest close-rate lever, infra ready) →
EE-2 → EE-3 (margin) → EE-4 (visuals) → EE-5 (cadence).

---

### EE-1 — AI-drafted good-better-best + optional add-ons `[S]` ⭐ flagship

| Attribute | Value |
|-----------|-------|
| Layer | Estimate AI |
| AI Buildability | Medium |
| Human Review | Heavy (money + AI behaviour) |
| Dependencies | Shipped GBB schema + customer selection UI + catalog grounding (no new deps) |
| Allowed Files | New `packages/api/src/ai/resolution/tier-structure.ts` (normalizer + request detector); `packages/api/src/ai/tasks/estimate-task.ts`; `packages/api/src/ai/tasks/mms-estimate-task.ts`; `packages/api/src/proposals/contracts.ts` (grouping fields + draft-refine); `packages/api/src/estimates/estimate.ts` (default-selection totals); `packages/web/src/components/inbox/InboxPage.tsx` (operator grouped review); plus the co-located tests. See the authoritative per-unit file list in `docs/plans/2026-07-17-001-feat-ai-good-better-best-estimates-plan.md`. |

**Build prompt:** Teach `draft_estimate` (and the MMS/photo estimate handler) to
optionally emit **tiered options** and **optional add-ons** into the existing
line-item schema. Extend `ESTIMATE_SYSTEM_PROMPT` so that when the request
implies choices ("good/better/best", "give them options", "offer an upgrade"),
the model groups mutually-exclusive tiers under a shared `groupKey` with a
human-readable `groupLabel`, marks exactly one tier `isDefaultSelected`, and
flags upsell lines `isOptional`. Every tier/add-on line still flows through the
existing `groundLineItemPricing` pass unchanged — prices come from the catalog,
uncatalogued tier lines still cap confidence and force review. Shape the payload
so the default selection yields a valid billed set the billing engine can total.

**Review prompt:** Verify prices remain catalog-grounded per line (no LLM prices
leak through tiers), exactly one default per group, add-ons default to the
customer's benefit (not silently pre-checked to inflate the total), and the
confidence caps / `requiresReview` gate still fire on ungrounded tier lines.

**Automated checks:** `handler-level tests with mocked gateway + in-memory
catalog`; assert grouped output shape, single default per group, catalog
grounding preserved, confidence cap on uncatalogued tier line; `tsc --project
tsconfig.build.json --noEmit`.

**Acceptance criteria:**
- A prompt implying options produces ≥2 line items sharing a `groupKey`, each
  catalog-grounded, exactly one `isDefaultSelected`.
- Optional upsell lines carry `isOptional` and are not defaulted-on unless the
  request says so.
- An uncatalogued tier line still caps proposal confidence below auto-approve and
  sets `requiresReview` (existing invariant unbroken).
- Billing totals for the default selection match `billing-engine`.
- Flat (non-optioned) requests still draft exactly as today — byte-identical
  prompt path when no options are implied.

**Non-goals:** Do not modify the customer selection UI (already shipped). Do not
add financing. Do not change the catalog resolver's grounding logic.

---

### EE-2 — Catalog item cost capture `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | Catalog / Billing |
| AI Buildability | High |
| Human Review | Moderate (money field + migration) |
| Dependencies | None |
| Allowed Files | `packages/api/src/catalog/catalog-item.ts`, `packages/api/src/catalog/pg-catalog-item.*`, `packages/api/migrations/*catalog*`, `packages/web/src/components/forms/CatalogPicker.tsx`, catalog editor sheet under `packages/web/src/components/settings/**` |

**Build prompt:** Add a nullable integer `unitCostCents` to `CatalogItem`
(create/update inputs, repo, migration, audit metadata) and surface it in the
catalog item editor UI. Integer cents only. Nullable so existing items and the
happy path are unaffected until a cost is entered.

**Review prompt:** Review money-field integrity (integer cents, no float),
migration reversibility, nullability handling, and that cost never leaks onto
customer-facing surfaces.

**Automated checks:** `catalog unit + integration tests (real Postgres)`;
`migration up/down`; `tsc --project tsconfig.build.json --noEmit`.

**Acceptance criteria:** Cost persists and round-trips as integer cents; null
cost is valid; cost is editable in the catalog UI; cost never appears on the
public estimate view; audit event records the change.

**Non-goals:** No margin logic yet (EE-3). No assemblies. No cost on customer
surfaces.

---

### EE-3 — Margin-floor drafting guardrail `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | Guardrails / Estimate AI |
| AI Buildability | Medium |
| Human Review | Heavy (money guardrail) |
| Dependencies | EE-2 |
| Allowed Files | `packages/api/src/ai/resolution/catalog-resolver.ts` (or a new `packages/api/src/ai/guardrails/margin.ts`), `packages/api/src/ai/tasks/estimate-task.ts`, `packages/api/src/ai/tasks/invoice-task.ts`, tenant settings module, matching tests |

**Build prompt:** When a drafted/edited line has a catalog `unitCostCents` and
its price implies a margin below the tenant's configured floor
(`min_margin_bps`, default e.g. 2000 = 20%), flag the line, cap proposal
confidence below the auto-approve threshold, and add a `_meta` marker — mirroring
the existing `UNCATALOGUED_CONFIDENCE_CAP` / `requiresReview` pattern. Pure,
deterministic, unit-testable (no I/O), same as the catalog resolver.

**Review prompt:** Confirm the guardrail only caps + requires review (never hard-
blocks a legitimate owner-approved low-margin job), integer-cents math, correct
behaviour when cost is null (no-op), and that it composes with the uncatalogued
cap without double-penalising.

**Automated checks:** `pure-function unit tests` (margin boundaries: at floor,
1bp below, cost null, cost > price); `handler test` asserting confidence cap +
marker; `tsc --project tsconfig.build.json --noEmit`.

**Acceptance criteria:** A line priced below the tenant floor caps confidence and
surfaces a review marker; a line at/above the floor is untouched; null cost is a
no-op; owner can still approve after review.

**Non-goals:** No hard block. No margin display on customer surfaces. No repricing
suggestions (future).

---

### EE-4 — Visual line items (equipment photos on proposals) `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | Catalog / Customer UI |
| AI Buildability | Medium |
| Human Review | Moderate |
| Dependencies | EE-2 optional; reuses P0-010 file storage |
| Allowed Files | `packages/api/src/catalog/catalog-item.ts` (+ repo/migration), `packages/api/src/estimates/public-estimate-service.ts`, `packages/web/src/components/customer/EstimateApprovalPage.tsx`, catalog editor UI, tests |

**Build prompt:** Add an optional image reference to `CatalogItem` (via the
existing S3 upload / presigned-URL flow from P0-010 — do not build new storage),
carry the resolved image onto grounded line items in the public estimate view,
and render a thumbnail beside each line on `EstimateApprovalPage`. Keep tap
targets ≥44px and no horizontal overflow at 320px per the mobile UI contract.

**Review prompt:** Review signed-URL handling (no public bucket leakage), graceful
absence of an image, and mobile layout (thumbnail must not break the 320px
class-contract / Playwright viewport tests).

**Automated checks:** `public-estimate-service tests`; `jsdom class-contract +
Playwright viewport test` for the approval page; `tsc --project
tsconfig.build.json --noEmit`.

**Acceptance criteria:** A catalog item with an image renders a thumbnail on the
customer proposal; items without images render exactly as today; images served
via time-limited signed URLs; mobile tap-target + overflow contracts hold.

**Non-goals:** No image editing/cropping. No AI image generation. No new storage
subsystem.

---

### EE-5 — Multi-touch follow-up cadence `[S]` (enhancement)

| Attribute | Value |
|-----------|-------|
| Layer | Workers |
| AI Buildability | High |
| Human Review | Moderate |
| Dependencies | Existing `estimate-reminder-worker.ts` |
| Allowed Files | `packages/api/src/workers/estimate-reminder-worker.ts`, `packages/api/src/estimates/estimate-nudge.ts`, tenant settings module, `packages/api/test/workers/estimate-reminder-worker.*` |

**Build prompt:** Extend the existing reminder sweep from single-touch to a small
configurable cadence (e.g. day 3 then day 7, tenant-settable offsets) and allow
an optional email channel in addition to SMS. Preserve the current two-layer
idempotency, per-revision engagement reset, and stop-on-view/accept/reject
behaviour. This is an *extension* of the shipped worker, not a new worker.

**Review prompt:** Review idempotency across the multi-touch schedule (no double-
send within a step), quiet-hours/timezone respect, and that stop conditions still
short-circuit every step.

**Automated checks:** `worker tests with fixed clock + in-memory repos` covering
multi-step cadence, cap, stop conditions, channel selection; `tsc --project
tsconfig.build.json --noEmit`.

**Acceptance criteria:** A sent-but-unanswered estimate receives reminders on the
configured offsets up to the cap; any view/accept/reject halts the cadence; email
channel works when configured; existing single-touch tenants unaffected by
default.

**Non-goals:** No outbound AI calling. No new notification infrastructure.

---

## 4. Not scoped here

- **Consumer financing / monthly-payment framing** — the one adversarially-
  verified competitor lever. **Deferred by product decision (2026-07-17)** due to
  lender-partner and regulatory surface area. When revisited, design it as a
  pluggable multi-provider layer with a waterfall, computing an "as-low-as"
  figure from the catalog-grounded quote total and rendering it inside the
  approval gate — not bolted on afterward.
- **Assemblies** (catalog item → labour + materials components) — larger than an
  S story; the flat `CatalogItem` model would need a components layer. Needs a
  `ce-plan` decomposition before any story is dispatched (M+ per sizing policy).

## 5. Open research gaps

Competitor sites blocked automated fetching, so these remain unverified and are
worth a second pass or a couple of trial accounts: field speed-to-estimate
benchmarks, exact good-better-best close-rate numbers, and Jobber's estimating
specifics for the SMB segment closest to us.
