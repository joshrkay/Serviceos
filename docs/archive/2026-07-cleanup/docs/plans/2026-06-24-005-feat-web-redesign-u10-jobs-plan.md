# feat: Web redesign U10 — Jobs cluster to Path A + UI-kit migration

**Created:** 2026-06-24
**Depth:** Deep
**Status:** plan

## Summary
Bring the entire Jobs cluster — the list, the owner JobDetail, the tech-facing
TechJobView, the new-job wizard, the job form, and all the action sheets — onto
the Path A brand, and migrate their hand-rolled controls (forms + sheet inputs)
to the shared UI kit. This is the largest cluster in the redesign (~900 raw-
palette occurrences across ~14 files; `JobDetail` alone is 234) and carries two
specific wrinkles the earlier clusters didn't: a small set of **color-coupled
tests** (`TechJobView.test.tsx`) that must update in lockstep, and an untested,
job-creating `JobForm` that needs coverage before its kit migration.

## Problem Frame
The jobs screens hardcode the raw Tailwind palette, so the Path A token swap
doesn't reach them, and their forms/sheets are hand-rolled — inconsistent with
the now-kit-based customers/estimates/invoices clusters. Affects every operator
and field tech viewing or editing a job. Two traps: `TechJobView`'s selected-
chip assertions pin `bg-indigo-600` literally (a blind recolor breaks them), and
`JobForm` POSTs `/api/jobs` with **no test** (a blind kit migration could change
the request unnoticed).

## Requirements
- R1. The jobs cluster renders on Path A — zero raw Tailwind palette in the
  touched files (grep-clean).
- R2. Forms + sheet inputs migrate to the kit (`Field` + `Input`/`Select`/
  `Textarea` + `Button`): `JobForm`, `NewJobFlow`'s form inputs, and the sheet
  inputs (`MaterialsSheet`, `SuppliersSheet`, `AddEntrySheet`,
  `CancelNoShowSheet`, `JobSheets`), preserving accessible names and ≥44px
  (`min-h-11`). Bespoke wizard option/selection cards stay recolored-native.
- R3. `TechJobView.test.tsx`'s 2 `toHaveClass('bg-indigo-600')` assertions update
  in lockstep with the recolor (selected chip → `bg-primary`).
- R4. **Mutation/money integrity:** `MaterialsSheet`'s "Unit cost ($)" field and
  any cents conversion are preserved; `JobForm`'s `/api/jobs` POST body is
  unchanged; the JobDetail/TechJobView mutations are untouched (recolor is visual
  only). Loading **spinner classes are preserved** (master-plan note).
- R5. Coverage-first for the untested, job-creating `JobForm` before its kit
  migration.
- R6. No regressions: existing job tests (`JobsList`, `JobDetail`, `TechJobView`,
  `NewJobFlow`, `ClockInOutButton`, `JobCreate`) stay green; full web suite green.

## Key Technical Decisions
- **Whole-cluster recolor + comprehensive kit migration** — *(user-confirmed
  both forks)*: all ~14 files recolor; all genuine form/sheet inputs move to the
  kit (not just the canonical form).
- **No overdue derivation here** — unlike invoices, the job money-state
  (including `'overdue'`) is **server-sent**: `normalizeJobMoneyState` is a
  passthrough (`return state as JobMoneyState`). There is no dead client
  derivation to fix; U10 is recolor + kit only. (Contrast U9, where overdue was
  an unreachable client path — checked, not assumed.)
- **Coverage-first only where it's earned** — `JobForm` is untested **and**
  directly POSTs `/api/jobs` → characterize first (U10f) then migrate (U10g),
  the U9c/U9d pattern. The sheets are untested but **don't mutate directly** —
  they collect input and hand it up via callbacks to already-tested parents
  (`JobDetail`/`TechJobView`), so their kit migration is presentational and
  guarded by a class-contract/smoke test rather than a full characterization.
  `NewJobFlow`, `JobDetail`, `TechJobView` are tested, so their migrations are
  guarded; only `TechJobView`'s color-coupled assertions need editing.
- **Preserve `aria-label` keys through every kit swap** (the U7b convention) so
  test queries and accessible names survive unchanged.
- **Bespoke wizard cards stay custom** — `NewJobFlow`'s ~30 buttons are mostly
  large selection/step cards; migrate the genuine inputs to kit and recolor the
  cards, as with `NewEstimateFlow` (U8e).
- **Don't recolor spinner classes a test pins** — the master note flags spinner
  classes; verify the recolor map doesn't rewrite a loading-spinner color class
  that `ClockInOutButton`/`JobDetail` tests assert.

## Scope Boundaries
**In scope:** recolor + kit migration of all jobs components and pages listed in
the units; the 2 `TechJobView` test updates; a `JobForm` characterization test.
**Non-goals:**
- No overdue/money-state derivation (server-sent).
- No change to job mutations, the `/api/jobs` POST contract, or `MaterialsSheet`'s
  cents handling.
- No new sheet behavior — presentation/structure only.

### Deferred to follow-up work
- Migrating `NewJobFlow`'s bespoke selection/step cards to kit Buttons (recolored
  only — kit Button doesn't fit large multi-line cards).
- Tenant-tz nuances in any job date rendering (out of scope here).

## Repository invariants touched
- **Integer cents:** `MaterialsSheet` collects a dollar "Unit cost" that converts
  to cents (in the sheet or its parent); the kit swap changes the input's
  presentation only — the value/onChange wiring and any `Math.round(*100)` are
  preserved. Other job money displays recolor without touching their math.
- **Audit / RLS / mutations:** the JobDetail/TechJobView/JobForm mutations emit
  audit events server-side and are unchanged — U10 is presentational/structural.
- LLM gateway / proposals / catalog & entity resolvers: not touched.

## Implementation Units

### U10a. Jobs list + leaf components recolor
- **Goal:** Re-brand the list entry point and the small leaf components; migrate
  the list's search input to the kit.
- **Requirements:** R1, R2
- **Dependencies:** U2, U4 (landed)
- **Files:** `packages/web/src/components/jobs/JobsList.tsx` (~24),
  `ActivityTimeline.tsx` (~30), `ClockInOutButton.tsx` (~7),
  `JobPhotoGallery.tsx` (~4), `JobPhotoUploader.tsx` (~2),
  `JobsPage.tsx` (0), `pages/jobs/{JobPhotos,JobTimeEntry}.tsx` (~1–3),
  `JobsList.test.tsx` (extend — class-contract).
- **Approach:** Apply the reusable token map; status already routes through the
  shared `StatusBadge`; the job money-state label recolors via tokens. Migrate
  the `JobsList` search `<input>` → kit `Input` (`min-h-11`, preserve aria/
  placeholder). **Verify the recolor doesn't rewrite a spinner class** the
  `ClockInOutButton` test pins.
- **Patterns to follow:** U8a/U9b recolor; the collision-ordered token map.
- **Test scenarios:** existing `JobsList`/`ClockInOutButton` tests stay green;
  class-contract guard (no raw palette) on the list; the search input carries
  `min-h-11`.
- **Verification:** grep-clean of all U10a files; tests green; `tsc` clean.

### U10b. JobDetail recolor + kit controls
- **Goal:** Re-brand the largest file and migrate its 4 controls.
- **Requirements:** R1, R2, R4
- **Dependencies:** U2
- **Files:** `packages/web/src/components/jobs/JobDetail.tsx` (~234),
  `JobDetail.test.tsx` (extend); also `pages/jobs/JobDetail.tsx` (0 — re-verify).
- **Approach:** Token-swap; migrate the 4 form controls → kit (preserve aria-
  labels, `min-h-11`); leave the 8 mutations and any money displays untouched
  (recolor only). Watch for spinner classes.
- **Patterns to follow:** U9b InvoicesPage recolor; U7b/U9d kit migration.
- **Test scenarios:** existing `JobDetail.test` stays green; class-contract
  guard; a migrated control carries `min-h-11`.
- **Verification:** grep-clean; tests green; full web suite green; `tsc` clean.

### U10c. TechJobView recolor + kit + color-coupled test lockstep
- **Goal:** Re-brand the tech view and update its color-coupled assertions.
- **Requirements:** R1, R2, R3, R4
- **Dependencies:** U2, U4
- **Files:** `packages/web/src/components/jobs/TechJobView.tsx` (~150),
  `TechJobView.test.tsx` (update the 2 `toHaveClass` assertions).
- **Approach:** Token-swap (`bg-indigo-600` selected-chip → `bg-primary`);
  migrate the 1 control → kit; **update `TechJobView.test.tsx` lines ~74/81**
  from `toHaveClass('bg-indigo-600')` / `not.toHaveClass('bg-indigo-600')` to
  `bg-primary` in the SAME commit (R3). Preserve the 8 mutations and spinner
  classes.
- **Patterns to follow:** the recolor map; the test's existing chip-selection
  flow.
- **Test scenarios:** the selected tip-chip carries `bg-primary` after click and
  not before (updated assertions); rest of `TechJobView.test` stays green;
  class-contract guard.
- **Verification:** grep-clean; updated TechJobView tests green; `tsc` clean.

### U10d. Job action sheets recolor + kit inputs
- **Goal:** Re-brand and kit-migrate the action sheets.
- **Requirements:** R1, R2, R4
- **Dependencies:** U2
- **Files:** `packages/web/src/components/jobs/JobSheets.tsx` (~55),
  `AddEntrySheet.tsx` (~37), `MaterialsSheet.tsx` (~39),
  `SuppliersSheet.tsx` (~55), `CancelNoShowSheet.tsx` (~29); new co-located
  class-contract/smoke tests where a sheet has input logic (esp.
  `MaterialsSheet`).
- **Approach:** Token-swap; migrate each sheet's inputs → kit `Input`/`Select`/
  `Textarea` (preserve aria-labels, `min-h-11`). **`MaterialsSheet`: preserve the
  "Unit cost ($)" field's value/onChange and any cents conversion** — the kit
  swap is presentational. Sheets pass data up via callbacks (no direct mutation),
  so behavior is guarded by the parent + a light smoke test that the sheet's
  inputs still collect + emit values.
- **Patterns to follow:** U8f convert-sheet recolor + kit; U7b aria-label
  preservation.
- **Test scenarios:** new smoke/class-contract for `MaterialsSheet` (typing into
  the migrated qty/cost inputs updates state / emits the expected payload to its
  callback; no raw palette); class-contract guards on the others. (Split into two
  commits if the diff gets large.)
- **Verification:** grep-clean of all 5 sheets; new + existing tests green; full
  web suite green; `tsc` clean.

### U10e. NewJobFlow recolor + kit form inputs
- **Goal:** Re-brand the new-job wizard and migrate its genuine form inputs.
- **Requirements:** R1, R2
- **Dependencies:** U2
- **Files:** `packages/web/src/components/jobs/NewJobFlow.tsx` (~179),
  `NewJobFlow.test.tsx` (extend if a migrated input isn't covered).
- **Approach:** Token-swap (collapse any categorical/service chips to neutral, as
  in U7a/U8e); migrate the form `<input>`/`<textarea>` → kit, leaving the bespoke
  step/selection **cards** recolored-native. The existing test covers the
  customer create/select flow — keep it green; add a light assertion if a
  migrated input (e.g. a job-detail field) isn't exercised.
- **Patterns to follow:** U8e NewEstimateFlow recolor; U7b kit migration.
- **Test scenarios:** existing `NewJobFlow.test` flows stay green; class-contract
  guard on the entry screen; a migrated input carries `min-h-11`.
- **Verification:** grep-clean; tests green; full web suite green; `tsc` clean.

### U10f. JobForm characterization test (coverage-first, no recolor)
- **Goal:** Pin `JobForm`'s `/api/jobs` POST behavior before migration.
- **Requirements:** R5
- **Dependencies:** none (runs against current `JobForm`)
- **Files:** `packages/web/src/components/jobs/JobForm.test.tsx` (new).
- **Approach:** Render with mocked `useListQuery`/`apiFetch`, fill the controls,
  submit, assert the exact POST to `/api/jobs` — method, URL, body shape — plus
  the selector population and required-field gating. Commit **before** U10g.
- **Patterns to follow:** `InvoiceForm.test.tsx` (U9c), `EstimateCreate.test`,
  `CustomerEdit.test`.
- **Test scenarios:** selectors populate; submit POSTs `/api/jobs` with the
  correct body; a missing required field creates no job. Passes against the
  unmodified hand-rolled form.
- **Verification:** new test passes against current `JobForm`.

### U10g. JobForm → kit + recolor
- **Goal:** Rebuild `JobForm` on the kit, guarded by U10f.
- **Requirements:** R1, R2, R4
- **Dependencies:** U10f
- **Files:** `packages/web/src/components/jobs/JobForm.tsx` (~10),
  `JobForm.test.tsx` (extend).
- **Approach:** `<select>`→`Select`, `<input>`→`Input`, `<textarea>`→`Textarea`
  in `Field`s; buttons → `Button`; preserve the POST body, validation, accessible
  names; add `min-h-11`. Remove any dead `inputCls`/unused imports.
- **Patterns to follow:** U9d InvoiceForm kit migration + the aria-label doc.
- **Test scenarios:** U10f characterization stays green (POST unchanged); kit
  semantics (Field id/label wiring; controls + buttons `min-h-11`); a Select
  selection rides into the POST.
- **Verification:** grep-clean; U10f + new assertions green; full web suite
  green; `tsc` clean.

## Risks & Dependencies
- **Color-coupled tests (highest-specificity risk).** `TechJobView`'s
  `toHaveClass('bg-indigo-600')` must be edited with the recolor or the build
  goes red. Mitigation: R3 — both assertions updated in U10c's commit.
- **Untested JobForm refactor.** Mitigation: R5 coverage-first (U10f → U10g).
- **MaterialsSheet money input.** A botched kit swap could drop the cost value.
  Mitigation: preserve value/onChange; a smoke test emits the expected payload.
- **Sheet behavior is untested.** Mitigation: sheets don't mutate directly;
  parents are tested; add light smoke/class-contract for input-bearing sheets.
- **Spinner classes.** Mitigation: scan the recolor for spinner-color rewrites a
  test pins (master note).
- **Size.** ~900 occurrences / 7 units — a long ce-work; each unit is an
  independent atomic commit, so it can pause between units.

## Open Questions (deferred to implementation)
- `JobForm`'s exact POST body (does it send nested customer/location, scheduling
  cents, etc.?) — U10f pins whatever it is.
- Whether `MaterialsSheet` converts the dollar cost to cents itself or passes
  dollars to the parent — preserve whichever it does.
- Whether `NewJobFlow.test` already exercises every migrated input or needs a
  small addition — decided when migrating.

## Sources & Research
- `packages/web/src/utils/statusNormalize.ts` (`normalizeJobMoneyState` is a
  passthrough — no overdue derivation, contrast U9).
- `docs/solutions/architecture-patterns/web-palette-to-token-class-migration.md`,
  `docs/solutions/conventions/preserve-aria-label-through-kit-form-migration.md`.
- Master plan U10 entry in `2026-06-24-001-feat-web-redesign-path-a-plan.md`
  (JobDetail its own commit; TechJobView `toHaveClass` lockstep; preserve
  spinner classes).
