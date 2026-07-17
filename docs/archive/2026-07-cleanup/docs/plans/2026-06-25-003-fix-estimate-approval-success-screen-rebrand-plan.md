# fix: EstimateApprovalPage SuccessScreen brand leak (Fieldly → tenant identity)

**Created:** 2026-06-25
**Depth:** Lightweight
**Status:** plan

## Summary

The customer-facing estimate-approval **success screen** (shown after a
customer accepts an estimate) hardcodes the platform's old brand — "Fieldly
Pro Services", an "F" avatar, "Austin, TX", and a fake phone number — instead
of the tenant's real business identity. The rest of the page already renders
the dynamic `businessName`/`businessPhone` from `apiView`; `SuccessScreen` was
simply never wired to them. This fixes the leak by threading the real tenant
identity into `SuccessScreen` and pins it with a positive branding test.

> **Verification note (2026-06-25):** all anchors checked against the working
> tree. `packages/web/src/components/customer/EstimateApprovalPage.tsx`:
> `SuccessScreen` is `function` at line 356; hardcoded "F"/"Fieldly Pro
> Services" at **385/388** (success header), **462/464** (job-card header);
> mock "Austin, TX" at **389**, `tel:5125550000` at **393**, `jobNumber =
> 'JOB-1053'` at **375**. Parent already derives `businessName`
> (769) and `businessPhone` (771); the **non-success** header (879–895) renders
> them correctly. `SuccessScreen` is rendered at **845–864** (when `accepted`),
> and `accepted` flips when `apiView.status === 'accepted'` (line 634).

## Problem Frame

A customer who approves an estimate lands on `SuccessScreen`. Today that screen
greets them with another company's name — "Fieldly Pro Services" — plus a stale
city and phone number, regardless of which tenant sent the estimate. This is a
real, shipped, customer-visible branding bug (not merely a stale test string):
`SuccessScreen` is the live `accepted`-state render. Every other surface on the
page already shows the tenant's real `businessName`; only this screen was left
on hardcoded placeholder data.

## Requirements

- **R1.** The success screen renders the tenant's real `businessName` (from
  `apiView`) in both the page header and the job card — no "Fieldly Pro
  Services" anywhere in `EstimateApprovalPage.tsx`.
- **R2.** The success-screen avatar shows the tenant's initial
  (`businessName.charAt(0).toUpperCase()`), not a hardcoded "F".
- **R3.** The success-screen contact affordances mirror the live non-success
  header: phone link uses `businessPhone` (conditional, hidden when absent);
  the data-less "Austin, TX" city line is removed.
- **R4.** A regression test renders the `accepted` state and asserts the real
  `businessName` appears while "Fieldly Pro Services" does not.

## Key Technical Decisions

- **Thread real identity into `SuccessScreen`; mirror the proven header.** Add
  `businessName: string` + `businessPhone?: string` to `SuccessScreen`'s props,
  pass them at the call site (845–864), and replace the hardcoded markup with
  the exact shape the non-success header already uses (881–895:
  `{businessName.charAt(0).toUpperCase()}` avatar, `{businessName}`, conditional
  `businessPhone`). Rationale: one component already does this correctly in the
  same file — copy it, don't invent. (Alternative: a shared `<TenantHeader>`
  extraction for both headers — rejected as scope creep for a Lightweight fix;
  noted as a deferred cleanup.)

- **Drop "Austin, TX" rather than fake a city.** `apiView` exposes only
  `businessName` (40) and `businessPhone?` (41) — there is no city/address
  field. The live header (879–895) shows name + phone and no city, so the
  success header should match. (Alternative: invent a placeholder/derive a city
  — rejected; no data source, and inventing location data for a customer is
  worse than omitting it.)

- **Leave `jobNumber = 'JOB-1053'` for a follow-up.** It is also fake data, but
  showing a real job number requires the accept response to surface the
  created job's number and thread it through — a data-wiring change, not a
  rebrand. Out of scope here; flagged below.

- **Keep the error test's "Fieldly Pro Services" absence assertions.**
  `EstimateApprovalPage.error.test.tsx:88,152` assert the string never renders
  in error/loading states. They still pass post-fix and remain valid
  regression guards (no stale fixture data leaking on non-happy paths); no edit
  needed.

## Scope Boundaries

**In scope:** `packages/web/src/components/customer/EstimateApprovalPage.tsx`
(`SuccessScreen` only); a new
`packages/web/src/components/customer/EstimateApprovalPage.success.test.tsx`.

**Non-goals:** the non-success render path (already correct); palette/kit recolor
(done in U13b); money formatting (`fmtUsd` already correct in `SuccessScreen`);
`apiView` shape / API changes; any other `Fieldly` occurrences outside this file
(e.g. `packages/api/src/db/schema.ts` seed/comments — a separate sweep).

### Deferred to follow-up work

- **`jobNumber = 'JOB-1053'` (line 375)** — fake job number shown to customers;
  needs the accept response to return the real job number + threading.
- **Shared `<TenantHeader>`** — the success and non-success headers now render
  near-identical name/avatar/phone markup; a later extraction would remove the
  duplication.
- **Phone-icon tap target** — the round phone link is `size-8` (32px), matching
  the existing non-success header; bumping both to ≥44px is a separate a11y pass.

## Repository invariants touched

None of the data/AI invariants apply — this is a presentational customer-facing
page with no money math change (`fmtUsd` on integer cents is already in place
and untouched), no DB/RLS, no audit events, no AI gateway, no proposals. The
governing rule is the `CLAUDE.md` code-hygiene line — remove "built but never
wired" / stub stand-ins (here: hardcoded mock brand data standing in for real
`apiView` fields) — plus the customer-facing correctness this fix restores.

## Implementation Units

### U1. Wire `SuccessScreen` to the tenant's real business identity (+ test)

- **Goal:** R1–R4 — the success screen shows the real tenant brand; a test pins
  it. (Source change and its test land in one commit per `CLAUDE.md`.)
- **Requirements:** R1, R2, R3, R4
- **Dependencies:** none
- **Files:**
  - `packages/web/src/components/customer/EstimateApprovalPage.tsx` (modify
    `SuccessScreen`, lines ~356–476, and its call site ~845–864)
  - `packages/web/src/components/customer/EstimateApprovalPage.success.test.tsx`
    (new)
- **Approach:**
  - Extend the `SuccessScreen` props type (360–373) with
    `businessName: string;` and `businessPhone?: string;`.
  - At the call site (845–864), pass `businessName={businessName}` and
    `businessPhone={businessPhone}` (both already in scope at 769/771).
  - Success header (384–396): replace the `>F<` avatar (385) with
    `{businessName.charAt(0).toUpperCase()}`; replace "Fieldly Pro Services"
    (388) with `{businessName}`; **delete** the "Austin, TX" line (389); replace
    the hardcoded `tel:5125550000` phone link (392–395) with the conditional
    `businessPhone` link exactly as the live header does (889–893), hiding it
    when `businessPhone` is empty.
  - Job-card dark header (460–465): replace the `>F<` avatar (462) with the
    initial and "Fieldly Pro Services" (464) with `{businessName}`.
  - Leave `jobNumber` (375), `fmtUsd` usage, deposit blocks, and all dynamic
    props (`customer`, `description`, `total`, `address`) unchanged.
  - Re-grep `Fieldly` in the file → expect zero matches afterward.
- **Patterns to follow:** the non-success header in the same file
  (`EstimateApprovalPage.tsx:879–895`) — the canonical avatar/name/phone markup
  to mirror; the accepted-state test harness in
  `EstimateApprovalPage.deposit.test.tsx` (line 34 `businessName: 'Acme HVAC'`,
  the `renderPage` helper at line 50, and `acceptedPayableView` with
  `status: 'accepted'` at 207–225 that drives `SuccessScreen` to render).
- **Test scenarios** (`EstimateApprovalPage.success.test.tsx`, mirror the
  deposit test's fetch-mock harness):
  - Happy path: mock the estimate fetch to return a view with
    `status: 'accepted'` and `businessName: 'Acme HVAC'`; render the page →
    `screen.getAllByText('Acme HVAC')` has length ≥ 2 (success header + job
    card), and `screen.queryByText(/Fieldly Pro Services/i)` is
    `not.toBeInTheDocument()`.
  - Avatar: assert the initial "A" renders in the header avatar (scope the query
    to the avatar element, or assert the header avatar span's text is the
    uppercased first letter of `businessName`) — guards R2 so a future
    hardcoded-letter regression is caught.
  - Phone present vs. absent: with `businessPhone` set, a `tel:` link is
    present; with `businessPhone` omitted/empty, no phone link renders (mirrors
    the live header's conditional) — guards R3.
  - Edge: a different fixture name (e.g. `'Zephyr Plumbing'`) renders its own
    initial "Z" — proves the value is derived, not coincidentally "A".
  - (No DB/integration test — this is a pure presentational component fed by a
    mocked fetch, the established pattern for this page's tests.)
- **Verification:** `cd packages/web && npx vitest run
  src/components/customer/EstimateApprovalPage` → the new success test plus the
  existing error/deposit/validity/layout tests all green; `grep -rn Fieldly
  packages/web/src/components/customer/EstimateApprovalPage.tsx` → 0 matches.
  Build stays clean via `cd packages/api && npx tsc --project
  tsconfig.build.json --noEmit` (web is covered by `tsc --noEmit`).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `getByText('Acme HVAC')` ambiguity (name appears twice) | Use `getAllByText(...)` with a length assertion, mirroring the error test's `getAllByText(/Drain repair/i)` pattern. |
| Avatar-initial assertion brittle (single letter "A" appears elsewhere) | Scope the query to the avatar `<span>` (e.g. via its container), not a page-wide `getByText('A')`. |
| `businessPhone` undefined in a fixture breaks the phone link | The link is rendered conditionally (`businessPhone && …`) exactly as the live header (889) — absent phone simply omits the icon. |
| The deposit/validity tests already render `SuccessScreen` | They assert on deposit/validity, not the business name, so the name change does not break them; re-run to confirm. |

## Open Questions (deferred to implementation)

- Exact query used to scope the avatar-initial assertion (depends on the
  rendered DOM structure of the avatar `<span>`) — resolve while writing the
  test.
- Whether to colocate the new test or fold it into
  `EstimateApprovalPage.error.test.tsx`; a dedicated `*.success.test.tsx` is
  recommended for discoverability, but either satisfies R4.
