# feat: Web redesign U9 — Invoices list + detail to Path A, with derived-overdue fix

**Created:** 2026-06-24
**Depth:** Deep
**Status:** plan

## Summary
Bring the Invoices cluster (list, detail, the create form, and the proposal
review) onto the Path A brand, migrate the hand-rolled `InvoiceForm` to the UI
kit, and fix a real correctness gap the redesign surfaced: web's "Overdue"
invoice UI is currently **dead code** — the canonical API has no `overdue`
status and web never derives it, so the overdue banner / "Send payment reminder"
path never fires. U9 derives overdue the way mobile already does, via a shared
rule so the two front-ends can't drift.

## Problem Frame
Two problems for anyone managing invoices on web:
1. **Brand:** the invoices screens hardcode the raw Tailwind palette (~220
   occurrences across 4 files; `InvoicesPage` is 191), so the Path A token swap
   doesn't reach them.
2. **Dead overdue UI:** `normalizeInvoiceStatus` maps `open`/`partially_paid` →
   `'Unpaid'` and has **no** `overdue` mapping; the API never sends `overdue`
   (it's not in `InvoiceStatus`). So `InvoicesPage`'s `inv.status === 'Overdue'`
   branches (warning banner, reminder CTA, red treatment) are unreachable. Mobile
   *derives* overdue (`invoiceStatusBadge`: open/partially_paid + past `dueDate`
   → danger); web doesn't. An owner never sees that an invoice is overdue.

## Requirements
- R1. The invoices cluster renders on Path A — zero raw Tailwind palette in the
  touched files (grep-clean).
- R2. **Overdue is derived correctly:** an `open`/`partially_paid` invoice past
  its `dueDate` surfaces as `Overdue` (banner + reminder CTA + destructive tone)
  on web, via a **shared** pure rule used by both web's normalize and mobile's
  `invoiceStatusBadge` (no logic drift).
- R3. `InvoiceForm` is rebuilt on the kit (`Field` + `Input`/`Select`/`Textarea`
  + `Button`), preserving accessible names and ≥44px (`min-h-11`) tap targets.
- R4. **Money integrity:** `InvoiceProposalReview`'s `unitPrice ?? unitPriceCents`
  dual read stays byte-for-byte; `InvoiceForm`'s invoice-creating POST shape
  (incl. any integer cents) is preserved exactly.
- R5. Coverage-first for the untested, money-creating `InvoiceForm` before it's
  migrated.
- R6. No regressions: existing invoices tests **and** mobile `entityStatus`
  tests stay green; full web suite green.

## Key Technical Decisions
- **Derive overdue at the presentation boundary, from a shared rule** —
  *(user-confirmed)*. There is no `overdue` DB/API status by design; it's a
  derivation (status ∈ {open, partially_paid} ∧ `dueDate` < now). Extract that
  rule into one shared pure helper (`isInvoiceOverdue`) and have **both** web's
  status normalization and mobile's `invoiceStatusBadge` call it, so the two
  can't drift. (Alternatives: (a) add an `overdue` API status — rejected, it's
  not a persisted state and would fan out across the contract/DB; (b) duplicate
  the rule in web — rejected, drifts from mobile, which is exactly what a shared
  taxonomy/parity test prevents, cf. `proposal-action-class.ts`.)
- **Migrate the invoice forms to the kit** — *(user-confirmed)*. `InvoiceForm`
  is fully hand-rolled (3 inputs / 2 selects / 1 textarea / 2 buttons, no kit);
  `InvoicesPage`'s payment/send inputs likewise. Consistent with U7/U8.
- **Coverage-first for `InvoiceForm`** — it has **no test** and POSTs
  `/api/invoices` (money-creating). Land a characterization test on the current
  hand-rolled form before the kit migration (the U8 pattern for untested
  money-affecting flows).
- **Preserve `aria-label` keys through the kit swap** — keep the existing
  control accessible names so any test queries (and a11y) survive unchanged
  (`docs/solutions/conventions/preserve-aria-label-through-kit-form-migration.md`).
- **Leave the already-clean proposal components alone** — `InvoiceProposalEditor`
  and `InvoiceProposalActions` are 0-palette; don't touch them (the price-field
  split the master plan warned about lives in the Editor, which U9 does not
  recolor).
- **Mirror mobile's overdue comparison exactly** (`new Date(dueDate) < now`) for
  parity; the minor "due today in tenant tz vs UTC midnight" edge is accepted as
  shared behavior, not gold-plated here (noted in Open Questions).

## Scope Boundaries
**In scope:** shared `isInvoiceOverdue` helper + web/mobile wiring; recolor +
overdue-wiring of `InvoicesPage`; recolor of `InvoiceDetail` and
`InvoiceProposalReview`; `InvoiceForm` characterization test + kit migration +
recolor; kit migration of `InvoicesPage`'s form inputs.

**Non-goals:**
- No new API/DB `overdue` status; derivation is presentation-time only.
- No change to money math, the `unitPrice/unitPriceCents` dual read, or the
  invoice-creating POST contract.
- `InvoiceProposalEditor` / `InvoiceProposalActions` (already token-clean) and
  `InvoiceCreate` (0-palette wrapper) — untouched / re-verified only.

### Deferred to follow-up work
- Tenant-timezone-correct due-date boundary (vs the UTC-parse mobile uses).
- Migrating `InvoicesPage`'s ~25 bespoke action buttons to the kit (recolored
  only; like U8e's bespoke cards).

## Repository invariants touched
- **Integer cents:** `InvoiceProposalReview`'s `item.unitPrice ?? item.unitPriceCents`
  read and `Math.round(quantity * unitCents)` are preserved (recolor is visual
  only); `InvoiceForm`'s POST cents are pinned by U9c before migration.
- **UTC / tenant timezone:** the overdue rule compares `dueDate` to `now`;
  mirrors mobile (UTC parse). Tenant-tz boundary deferred (Open Questions).
- **Audit / RLS / LLM gateway / proposals / catalog & entity resolvers:** not
  touched — no server, contract, or data-path changes (the shared helper is a
  pure date/status function).

## Implementation Units

### U9a. Shared `isInvoiceOverdue` rule + wire web normalize + mobile badge
- **Goal:** One pure overdue rule, consumed by both front-ends; web gains a
  status derivation that can produce `Overdue`.
- **Requirements:** R2, R6
- **Dependencies:** none
- **Files:**
  - `packages/shared/src/contracts/invoice-status.ts` (new — `isInvoiceOverdue(status, dueDate, now)`)
  - `packages/shared/src/contracts/invoice-status.test.ts` (new)
  - `packages/shared/src/index.ts` (export)
  - `packages/web/src/utils/statusNormalize.ts` (add `deriveInvoiceUiStatus(apiStatus, dueDate, now)` → `'Overdue'` when overdue, else `normalizeInvoiceStatus`)
  - `packages/web/src/utils/statusNormalize.test.ts` (extend)
  - `packages/mobile/src/lib/entityStatus.ts` (refactor `invoiceStatusBadge` to call the shared rule)
- **Approach:** `isInvoiceOverdue(status, dueDate, now = Date.now())` returns true
  iff `status ∈ {'open','partially_paid'}` and `dueDate` parses and is `< now`.
  Mobile's `invoiceStatusBadge` keeps its `EntityBadge` return but sources the
  overdue test from the shared helper (delete its inline rule). Web adds
  `deriveInvoiceUiStatus` so callers that have `dueDate` get `'Overdue'`; plain
  `normalizeInvoiceStatus` is unchanged (other callers unaffected).
- **Patterns to follow:** `packages/shared/src/contracts/proposal-action-class.ts`
  (shared pure helper + parity test); mobile `entityStatus.ts`.
- **Test scenarios:**
  - Shared helper: open + dueDate yesterday → true; partially_paid + past → true;
    open + dueDate tomorrow → false; paid/draft/void + past → false; missing or
    unparseable `dueDate` → false; `now` injected for determinism.
  - Web `deriveInvoiceUiStatus`: open+past → `'Overdue'`; open+future → `'Unpaid'`;
    paid → `'Paid'`.
  - Mobile `entityStatus.test` stays green (same observable badges).
- **Verification:** new shared + web tests green; mobile entityStatus tests green;
  `tsc --noEmit` clean in shared, web, mobile.

### U9b. Invoices list recolor + overdue made reachable + kit inputs
- **Goal:** Re-brand `InvoicesPage` and wire the derived overdue so its banner/
  reminder actually fire; migrate its form inputs to the kit.
- **Requirements:** R1, R2, R3
- **Dependencies:** U9a
- **Files:** `packages/web/src/components/invoices/InvoicesPage.tsx` (~191),
  `packages/web/src/components/invoices/InvoicesPage.test.tsx` (extend).
- **Approach:** Apply the reusable token map; replace the `inv.status` source
  with `deriveInvoiceUiStatus(apiStatus, inv.dueDate)` at the mapping boundary so
  `'Overdue'` can appear (banner, "Send payment reminder" vs "Send payment link",
  destructive treatment) — keep the existing branch logic, just feed it a status
  that can be `Overdue`. Migrate the send/payment **inputs/textareas** to kit
  `Input`/`Textarea` (preserve aria-labels, `min-h-11`); the ~25 bespoke action
  buttons recolor in place (not kit Buttons). Status badges already route through
  the shared `StatusBadge` tone set (`Overdue → destructive`).
- **Patterns to follow:** U8a/U8e recolor; U7b/U8c kit-input migration; the
  collision-ordered token map + the migration solution doc.
- **Test scenarios:**
  - Overdue path (new): an `open` invoice with a past `dueDate` renders the
    Overdue banner / "Send payment reminder" CTA and the destructive-tone badge;
    an `open` invoice due in the future renders `Unpaid` and no banner.
  - Existing `InvoicesPage.test` behavior stays green.
  - Class-contract guard: rendered list has no raw palette.
  - Kit: a migrated send/payment input carries `min-h-11`.
- **Verification:** grep-clean; overdue + class-contract tests green; full web
  suite green; `tsc --noEmit` clean.

### U9c. InvoiceForm characterization test (coverage-first, no recolor)
- **Goal:** Pin `InvoiceForm`'s money-creating behavior on the current hand-rolled
  form so U9d is provably behavior-preserving.
- **Requirements:** R5
- **Dependencies:** none (runs against current `InvoiceForm`)
- **Files:** `packages/web/src/components/invoices/InvoiceForm.test.tsx` (new).
- **Approach:** Render with mocked `useListQuery`/`apiFetch`, fill the form, submit,
  and assert the **exact POST** to `/api/invoices` — method, URL, and body shape
  including any integer-cents fields (verify whether the client sends line-item
  cents or just job/estimate references; assert whatever it actually sends).
  Cover the job/estimate selectors and the required-field validation.
- **Patterns to follow:** `pages/estimates/__tests__/EstimateCreate.test.tsx`,
  `ConvertToInvoiceSheet.test.tsx` (U8f), `CustomerEdit.test.tsx`.
- **Test scenarios:** loads job/estimate options; submit POSTs `/api/invoices`
  with the correct body (integer cents if present); missing required field blocks
  submit. Commit **before** U9d so it passes on the hand-rolled markup.
- **Verification:** new test passes against the unmodified `InvoiceForm`.

### U9d. InvoiceForm → kit + recolor
- **Goal:** Rebuild `InvoiceForm` on the kit, guarded by U9c.
- **Requirements:** R1, R3, R4
- **Dependencies:** U9c
- **Files:** `packages/web/src/components/invoices/InvoiceForm.tsx` (~16),
  `packages/web/src/components/invoices/InvoiceForm.test.tsx` (extend).
- **Approach:** `<select>`→`Select`, `<input>`→`Input`, `<textarea>`→`Textarea`,
  wrapped in `Field` for labels; Save/Cancel `<button>`→`Button`. Preserve the
  submit/validation flow, the `/api/invoices` POST body, and accessible names;
  add `min-h-11`. Keep the cents construction (if any) untouched (U9c guards it).
- **Patterns to follow:** U7b `CustomerEdit` kit migration (`69e6a50c`) + the
  aria-label solution doc.
- **Test scenarios:** U9c's characterization stays green (POST body unchanged);
  add kit-semantics assertions (Field id/label wiring; controls + buttons
  `min-h-11`); a Select selection rides into the POST body.
- **Verification:** grep-clean; U9c + new assertions green; full web suite green;
  `tsc --noEmit` clean.

### U9e. InvoiceDetail + InvoiceProposalReview recolor
- **Goal:** Re-brand the remaining two files; preserve the money read.
- **Requirements:** R1, R4
- **Dependencies:** U9a (so detail can derive overdue if it surfaces status)
- **Files:** `packages/web/src/pages/invoices/InvoiceDetail.tsx` (~3),
  `packages/web/src/components/invoices/InvoiceProposalReview.tsx` (~10),
  co-located tests (extend if a class-contract guard is added).
- **Approach:** Token-swap both. In `InvoiceProposalReview`, the
  `item.unitPrice ?? item.unitPriceCents ?? 0` read and
  `Math.round(item.quantity * unitCents)` are **untouched** — recolor only.
  If `InvoiceDetail` renders a derived status, route it through
  `deriveInvoiceUiStatus`/`StatusBadge` for parity.
- **Patterns to follow:** U8 recolor; existing `InvoiceProposalReview.test`.
- **Test scenarios:** existing detail/review tests stay green (no color
  coupling); class-contract guard on one of them; the proposal review still
  renders the dual-read line totals correctly.
- **Verification:** grep-clean of both files; tests green; full web suite green.

## Risks & Dependencies
- **Overdue rule drift / wrong derivation (highest).** A bad rule mislabels
  invoices (an owner chases a paid invoice, or misses a real overdue one).
  Mitigation: single shared helper with explicit boundary tests (paid/future/
  missing-due all → not overdue), reused by mobile (whose tests must stay green).
- **InvoiceForm unguarded refactor.** Untested + money-creating. Mitigation: R5
  coverage-first (U9c before U9d).
- **Cross-front-end change.** U9a edits mobile. Mitigation: mobile
  `entityStatus.test` must stay green; the refactor only relocates the rule.
- **Money read in Review.** Mitigation: U9e is recolor-only; the dual-read line
  is not edited.

## Open Questions (deferred to implementation)
- Exact `InvoiceForm` POST body — does the client send line-item cents, or only
  job/estimate ids (backend builds the invoice)? U9c pins whatever it is.
- Tenant-timezone-correct due-date boundary vs mobile's UTC parse (deferred;
  parity-first).
- Whether `InvoiceDetail` surfaces a derived status worth routing through the
  shared helper, or only shows payment-status text.

## Sources & Research
- `packages/mobile/src/lib/entityStatus.ts` (`invoiceStatusBadge` — the overdue
  derivation to share); its test `entityStatus.test.ts`.
- `packages/web/src/utils/statusNormalize.ts` (`INVOICE_STATUS_MAP`, no overdue).
- `docs/solutions/architecture-patterns/web-palette-to-token-class-migration.md`,
  `docs/solutions/conventions/preserve-aria-label-through-kit-form-migration.md`,
  `docs/solutions/architecture-patterns/share-server-taxonomy-subset-parity-test.md`.
- Master plan U9 entry in `2026-06-24-001-feat-web-redesign-path-a-plan.md`.
