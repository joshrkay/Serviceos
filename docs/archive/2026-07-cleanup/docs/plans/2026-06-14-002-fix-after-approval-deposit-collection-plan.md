# fix: Collect after_approval deposits on the public estimate page and surface them in the portal

**Created:** 2026-06-14
**Depth:** Deep
**Status:** plan

## Summary
When a tenant uses the `after_approval` deposit timing policy, a customer accepts an
estimate and the job is left owing a deposit (`deposit_status='pending'`) with **no UI
to pay it** — `/e/:token` renders no pay control for `accepted` estimates and the
post-accept success screen silently drops the promised "pay your deposit" prompt. The
backend is already complete and tested (checkout minting has no status guard;
settlement is webhook-driven and policy-agnostic). This plan closes the **frontend**
gap on `/e/:token`, re-introduces the (previously reverted) portal "Pay deposit"
affordance now that its destination works, and adds the missing cross-layer test
coverage — centralizing the "is the deposit payable" rule so the two surfaces can't
drift.

## Problem Frame
Discovered during the quote-to-cash verification campaign and confirmed by a
settlement-lifecycle trace. The amber notice on `/e/:token` literally tells the
customer *"You'll be prompted to pay the deposit after approving this estimate"*
(`EstimateApprovalPage.tsx:1025`), but no such prompt is ever rendered: the fixed-CTA
block early-returns `null` for `accepted` (terminal) estimates
(`EstimateApprovalPage.tsx:1076`), and the re-sync poll only runs for `status==='sent'`
(`EstimateApprovalPage.tsx:606`). Affected: every customer of a tenant on the
`after_approval` policy (the **default** — `settings?.depositTimingPolicy ?? 'after_approval'`)
who accepts an estimate that requires a deposit. They are told money is owed with no way
to pay it; the tenant never collects the deposit through self-serve.

## What already works (verified — do NOT rebuild)
- **Acceptance writes the deposit onto the job** (after_approval): `public-estimate-service.ts:373-385` (`approve()` hook) sets `depositRequiredCents`, `depositPaidCents`, `depositStatus` via `evaluateDepositRule` + `deriveDepositStatus`. Acceptance is **not** blocked on an unpaid deposit for `after_approval` (correct).
- **Checkout link minting works for accepted estimates**: `public-estimate-service.ts:652-813` (`getOrCreateDepositCheckoutUrl`) — guards on link-expiry/Stripe-config/`required>0`/`paid<required` only; **no estimate-status guard**. Idempotent, expiry-managed, stamps `metadata.deposit_for_job_id`.
- **Settlement is complete + policy-agnostic + tested**: `webhooks/routes.ts:933-960` handles `checkout.session.completed` (`payment_status==='paid'`), looks up the job by `deposit_for_job_id`, caps `newPaid = min(prev+amount, required)`, writes `depositStatus = deriveDepositStatus(...)`. Tested in `packages/api/test/webhooks/checkout-session.test.ts:78-131`.
- **The estimate view already surfaces deposit context**: `public-estimate-service.ts:626-636` (`depositRequiredCents`, `depositPaidCents`, `depositStatus`, `depositTimingPolicy`, `depositCheckoutUrl`, `depositCheckoutExpiresAt`, `isActionable`).
- **`PayDepositButton` is reusable + policy-agnostic**: `EstimateApprovalPage.tsx:1130-1190` — mints/reuses the link and redirects to Stripe; works regardless of policy/status.

## Requirements
- R1. A customer who has accepted an estimate under `after_approval` with a pending deposit can pay it from `/e/:token` — both **immediately after accepting in-session** (the success screen) and **on a later return** (fresh load of the accepted estimate).
- R2. After the customer pays (returns from Stripe), the page detects settlement and updates to a "deposit paid / on file" read-only state without a manual refresh.
- R3. `before_approval` behavior is unchanged (still: pay-deposit gate before the Approve button; poll-driven swap to Approve once paid).
- R4. The customer portal estimate card surfaces the payable deposit ("$X deposit due" + "Pay deposit" → `/e/:token`) for the accepted estimate that owes one, without bleeding onto sibling estimates of the same job.
- R5. The "is this deposit payable" rule lives in **one** place, reused by the estimate view and the portal projection (no per-surface re-derivation).
- R6. Cross-layer coverage exists: after_approval acceptance leaves an unpaid pending deposit (not blocked); accepted estimate can mint a checkout link; webhook settles it; UI renders/clears the CTA.

## Key Technical Decisions
- **Generalize the deposit CTA around a single `depositPayable` concept instead of the `before_approval`-only `blockedByDeposit`.** Rationale: the existing CTA branch is policy-specific (`apiView.depositTimingPolicy === 'before_approval'`); a policy-agnostic "deposit owed on a live estimate" predicate covers both the existing before_approval pre-accept case and the new after_approval post-accept case with one branch, and removes the dead-end. (Alternative: add a second after_approval-only branch — rejected: duplicates logic and keeps two policy special-cases drifting.)
- **Put the rule in a shared pure helper `isDepositPayable(...)` and expose `depositPayable` on the estimate view.** Rationale: the prior code review on the reverted attempt flagged "deposit-actionability rule re-implemented in the card" as wrong altitude; centralizing it in `jobs/deposit-rule.ts` (next to `deriveDepositStatus`) lets `/e/:token`, the poll, and the portal projection all consume one truth. (Alternative: derive inline in each surface — rejected: 3+ copies, the exact drift the review called out.)
- **Reuse the existing `getOrCreateDepositCheckoutUrl` endpoint + `PayDepositButton` unchanged.** Rationale: both are already status-agnostic and tested; the fix is rendering, not new payment plumbing. No new endpoint, no new Stripe code.
- **Surface in the portal via click-through to `/e/:token` (no inline Stripe in the portal).** Rationale: same as the original intent — one tested payment surface; the portal links to it. Now valid because `/e/:token` collects the deposit. Gate strictly to `status==='accepted'` to avoid the job-level-deposit-bleeds-to-siblings bug the earlier review caught.
- **Detect settlement by broadening the existing re-sync poll, mirroring the invoice page.** Rationale: settlement is async (webhook fires after the Stripe return); the page already polls for `sent` estimates — extend the same mechanism to "accepted + depositPayable" and stop once `depositStatus==='paid'`. (Alternative: a Stripe return-url query param — rejected: the link's return is plain per the existing flow; polling is the established pattern, `useInvoiceStatus`.)

## Scope Boundaries
**In scope:** the `after_approval` deposit **payment UX** on `/e/:token` (post-accept success screen + returning-customer main view + paid-detection poll); a shared `isDepositPayable` helper + `depositPayable` view flag; re-introducing the portal estimate deposit badge/CTA gated to the accepted estimate; integration + e2e coverage for the accept→mint→settle→render chain.

**Non-goals:**
- Any change to deposit **settlement** (webhook), minting, or the rule evaluator — all verified working/tested.
- Changing the default timing policy or the `before_approval` flow's behavior.
- Embedding Stripe Elements inside the portal (portal links out to `/e/:token`).
- Deposit→invoice credit (`deposit_credited_to_invoice_id`, PR 3c) — already shipped, untouched.
- Operator-side deposit management UI.

### Deferred to follow-up work
- Extracting a shared portal money-status/CTA primitive across `PortalEstimateList`/`PortalInvoiceList` (duplication noted in the prior review).
- Surfacing `before_approval` deposits in the portal (job columns read 0 until link mint, so they aren't reliably visible there; handled on `/e/:token` during the `sent` phase).

## Repository invariants touched
- **Integer cents:** deposit amounts/remainder stay integer cents; remainder uses `Math.max(0, required - paid)`; settlement caps via `Math.min` (unchanged). No floats.
- **UTC / tenant tz:** deposit link expiry is ISO/UTC, rendered via the page's existing friendly-date helpers.
- **tenant_id + RLS:** portal projection stays scoped to `req.portal.{tenantId,customerId}`; `/e/:token` is view-token scoped. No new query crosses the boundary.
- **Audit events:** see Open Questions — confirm the webhook deposit settlement emits an audit event; if it doesn't, add one (applies to both policies). This plan adds no un-audited mutation (the only write, settlement, is pre-existing).
- **Human-approval gate / proposals / catalog resolver / entity resolver / LLM gateway:** not on this path — untouched. (Acceptance still goes through the existing approve flow; this plan only adds a payment affordance after it.)

## High-Level Technical Design

State of `/e/:token` deposit CTA after this change (one policy-agnostic gate):

```mermaid
flowchart TD
  L[Load /e/:token] --> P{depositPayable?\nstatus∈{sent,accepted}\n&& deposit pending\n&& !expired}
  P -- yes --> PD[Render PayDepositButton\n→ Stripe link]
  P -- no --> A{isActionable?}
  A -- yes --> AP[Render Approve CTA]
  A -- no --> RO[Read-only summary\n(notice shows Paid / terminal)]
  PD -->|customer pays, returns| POLL[Re-sync poll runs while\nsent OR depositPayable]
  POLL -->|depositStatus→paid| RO
  AP -->|after_approval accept| ACC[Accepted in-session]
  ACC --> PDsucc[Success screen surfaces\nPayDepositButton when depositPayable]
```

The before_approval flow is the `sent` path (pay → poll → Approve appears); the new
after_approval flow is the `accepted` path (accept → success screen prompts → pay →
poll → read-only paid). Both funnel through the same `depositPayable` predicate and the
same `PayDepositButton`.

## Implementation Units

### U1. Shared `isDepositPayable` helper + `depositPayable` on the estimate view
- **Goal:** One canonical predicate for "this estimate owes a payable deposit," exposed on the public estimate view so every surface consumes it instead of re-deriving.
- **Requirements:** R5 (enables R1/R4).
- **Dependencies:** none.
- **Files:**
  - `packages/api/src/jobs/deposit-rule.ts` — add `isDepositPayable(depositStatus, estimateStatus, isExpired)` (pure).
  - `packages/api/src/estimates/public-estimate-service.ts` — compute `depositPayable` in the view assembly (~line 626-636) using the helper; add to the returned object.
  - `packages/web/src/components/customer/EstimateApprovalPage.tsx` — add `depositPayable: boolean` to the `PublicEstimateView` interface (~lines 75-104).
  - (If a shared contract for the public estimate view exists under `packages/shared`, add the field there too — implementer to grep `PublicEstimateView`/`depositStatus` in `packages/shared`.)
  - Tests: `packages/api/test/jobs/deposit-rule.test.ts` (helper); `packages/api/test/estimates/public-estimate-service.test.ts` (view exposes flag).
- **Approach:** `isDepositPayable = depositStatus === 'pending' && !isExpired && (estimateStatus === 'sent' || estimateStatus === 'accepted')`. `pending` already encodes `required>0 && paid<required` (via `deriveDepositStatus`), so the helper layers only the liveness/status gate. Exclude `rejected`/`expired`. The service computes it from the same `computedStatus`/`isExpired`/`estimate.status` it already has in scope.
- **Patterns to follow:** `deriveDepositStatus` in the same file (pure, documented "use everywhere"); the view-assembly object at `public-estimate-service.ts:582-637`.
- **Test scenarios:**
  - Happy path: `pending` + `accepted` + not expired → `true`; `pending` + `sent` → `true`.
  - Edge: `paid` → `false`; `not_required` → `false`; `pending` + `expired`(status) → `false`; `pending` + `isExpired=true` → `false`; `pending` + `rejected` → `false`.
  - Integration (view): an accepted estimate whose job has `depositRequiredCents>0, depositPaidCents=0` → view `depositPayable===true`; once `depositPaidCents>=required` → `false`.
- **Verification:** The estimate view returns `depositPayable` correctly across sent/accepted/paid/expired/rejected; helper unit tests green.

### U2. `/e/:token` — render the pay-deposit control for payable deposits (incl. accepted) + paid-detection poll
- **Goal:** Let the after_approval customer actually pay — both immediately after accepting (success screen) and on a later return — and reflect settlement automatically. The core fix.
- **Requirements:** R1, R2, R3.
- **Dependencies:** U1.
- **Files:**
  - `packages/web/src/components/customer/EstimateApprovalPage.tsx`:
    - Fixed-CTA block (~1040-1099): replace the `blockedByDeposit` (before_approval-only) branch with a `apiView?.depositPayable` branch that renders `PayDepositButton` (+ `DeclineButton` when the estimate is still pre-accept), placed **before** the `isActionable === false → return null` line (1076). This is what makes accepted+pending estimates show the control.
    - Post-accept success view (`SuccessScreen`, shown when `accepted===true`, ~lines 348-527): when the just-accepted `apiView.depositPayable` is true, surface a deposit prompt reusing `PayDepositButton` (fulfilling the amber notice's promise) instead of a deposit-less success screen.
    - Re-sync poll (~604-625): broaden the gate from `apiView.status !== 'sent'` to "poll while `status==='sent'` **or** `apiView.depositPayable`"; stop when `depositStatus==='paid'`; on paid, refresh `apiView` so the CTA clears to the read-only/"Paid" state.
  - Tests: `packages/web/src/components/customer/EstimateApprovalPage.deposit.test.tsx` (extend).
- **Approach:** Drive everything off `apiView.depositPayable` (U1). `PayDepositButton` is reused as-is; consider a copy tweak for the accepted case (e.g. "Pay your $X deposit") — see Open Questions. Keep the amber notice. The poll change mirrors the invoice page's stop-on-terminal pattern. Confirm `before_approval` still: sent+pending → PayDeposit, pays → poll → Approve.
- **Patterns to follow:** the existing `blockedByDeposit` branch + `PayDepositButton` usage (`EstimateApprovalPage.tsx:1053-1073`); the invoice page poll (`useInvoiceStatus`).
- **Test scenarios:**
  - Happy path: after_approval, `status='accepted'`, `depositPayable=true` → `PayDepositButton` (`data-testid="estimate-pay-deposit-cta"`) renders; clicking POSTs `/deposit-checkout`.
  - Post-accept: simulate `onConfirm` with an accepted view that is `depositPayable` → success screen shows the deposit prompt.
  - Settlement reflect: poll returns a view with `depositStatus='paid'` → CTA disappears, "Paid"/read-only shown; poll stops.
  - Regression (before_approval): `status='sent'`, pending → PayDeposit shown; after paid view → Approve CTA shown; **no** PayDeposit on a paid/not_required estimate.
  - Mobile contract: the rendered CTA meets ≥44px (PayDepositButton uses `py-4`; assert tap-target/no-320px-overflow via the existing layout-contract approach).
- **Verification:** A customer can pay an after_approval deposit on `/e/:token` post-accept and on return; the page auto-updates to paid; before_approval unchanged. jsdom tests green.

### U3. Portal — surface the payable deposit on the estimate card (re-introduce, correctly gated)
- **Goal:** Re-add the portal "Pay deposit" affordance (reverted earlier because its destination was a dead end) now that `/e/:token` collects the deposit, gated to the accepted estimate so it can't mislabel siblings.
- **Requirements:** R4, R5.
- **Dependencies:** U1, U2 (destination must work first).
- **Files:**
  - `packages/api/src/routes/public-portal.ts` — `GET /:token/estimates` (~261-293): project `depositRequiredCents`, `depositPaidCents`, `depositStatus` (via `deriveDepositStatus` on the parent job), and `depositPayable` (via `isDepositPayable`) from the already-fetched job; keep the existing `jobsById` map approach.
  - `packages/web/src/api/portal.ts` — add the deposit fields to `PortalEstimate`.
  - `packages/web/src/pages/portal/PortalEstimateList.tsx` — show "$X deposit due" badge + "Pay deposit" CTA (→ `/e/:publicViewToken`, `min-h-11`) **only when `depositPayable && status==='accepted'`**; otherwise the existing "View & respond". "Deposit paid" badge also gated to `status==='accepted'` (no sibling bleed).
  - Tests: `packages/api/test/portal/portal-routes.test.ts` (projection) + `packages/web/src/pages/portal/__tests__/PortalEstimateList.test.tsx` (new).
- **Approach:** Mirror the `PortalInvoiceList` "Pay now" pattern (and the already-shipped invoice tap-target fix). The strict `status==='accepted'` gate is the fix for the prior review's "job-level deposit bleeds onto every estimate of the job" finding — only the accepted estimate owns the after_approval deposit.
- **Patterns to follow:** `PortalInvoiceList.tsx` (amount-due + "Pay now" + `min-h-11`); the earlier (reverted) projection shape; `formatPortalCents`.
- **Test scenarios:**
  - Route: accepted estimate + job pending deposit → card payload has `depositPayable=true`, correct cents; paid → `false`; a non-accepted sibling on the same job → no deposit surfaced (`depositPayable=false`).
  - Component: accepted + payable → "Pay deposit" CTA (`href=/e/:token`, `min-h-11`) + "$X deposit due"; paid → "Deposit paid", no CTA; sent/not_required → "View & respond", no deposit badge.
  - DB-touching → Docker-gated integration assertion that the projection reads the real `jobs.deposit_*` columns for a portal customer (extend the portal/job integration coverage).
- **Verification:** Portal shows a working "Pay deposit" on the accepted estimate that links to a page that collects it; no deposit text on sibling estimates.

### U4. End-to-end coverage for the after_approval deposit path
- **Goal:** Pin the cross-layer chain the verification campaign found untested: accept (not blocked) → mint link for accepted → webhook settles → UI reflects.
- **Requirements:** R6.
- **Dependencies:** U1, U2 (and U3 for the portal e2e).
- **Files:**
  - `packages/api/test/integration/deposit-after-approval.test.ts` (new, Docker-gated) — real Postgres.
  - `e2e/estimate-deposit-after-approval.spec.ts` (new, Playwright) — `/e/:token` flow + mobile viewport (320/390/1280).
  - (Settlement unit behavior already covered by `test/webhooks/checkout-session.test.ts` — do not duplicate; reference it.)
- **Approach:** Integration: seed a tenant with an `after_approval` deposit rule, a job, a sent estimate; accept it via the public flow → assert acceptance succeeds **and** job has `deposit_required_cents>0`, `deposit_status='pending'` (the "must not block" case the trace flagged missing); call the deposit-checkout path → assert a link + persisted `deposit_stripe_payment_link_*`; simulate the `checkout.session.completed` webhook with `deposit_for_job_id` → assert `deposit_paid_cents`/`deposit_status='paid'`. e2e: stub Stripe redirect; assert the deposit CTA appears post-accept, and the page resolves to "paid" after a simulated settled re-fetch.
- **Patterns to follow:** `packages/api/test/integration/*` harness (`shared.ts`, real-PG seeding); `test/webhooks/checkout-session.test.ts`; `e2e/estimate-approval-mobile.spec.ts`.
- **Test scenarios:**
  - Integration happy path: accept (after_approval, deposit rule) → not blocked, job pending; mint → link + persisted columns; webhook → paid.
  - Integration edge: partial webhook amount → still `pending`; over-amount → capped at required, `paid`.
  - e2e: accept → "Pay deposit" prompt visible (320px, ≥44px target); settled re-fetch → "Paid"/read-only.
  - DB-touching → this IS the Docker-gated integration test (mocked-DB insufficient — pins real `jobs.deposit_*` columns end to end).
- **Verification:** Integration + e2e green in CI; the after_approval accept→pay→settle chain is regression-guarded.

## Risks & Dependencies
- **Environment:** integration (Docker) + Playwright cannot run in the current sandbox (Docker Hub pull rate-limit observed this session) — U4 must be verified in PR CI. U1/U2/U3 unit + jsdom + route tests run locally.
- **Stripe return URL:** the deposit Payment Link's `return_url` must land back on `/e/:token` so the broadened poll can detect settlement. The `before_approval` flow already relies on this; confirm the same return target applies to the accepted case (it should — same mint path). If the link has no return_url, U2's "auto-reflect" depends solely on the customer reloading — note for the implementer to verify in `getOrCreateDepositCheckoutUrl`'s Payment Link payload.
- **Sequencing:** U2 must land before U3 ships to customers (portal must not link to a dead end again).

## Open Questions (deferred to implementation)
- **Audit event on settlement:** does `webhooks/routes.ts:933-960` emit an audit event when crediting the deposit? If not, add `job.deposit_paid` (or equivalent) — affects both policies; confirm against `createAuditEvent` usage in the webhook router. (Surface during U4.)
- **Success-screen UX/copy:** exact placement and wording of the post-accept deposit prompt ("Pay your $X deposit to confirm scheduling") — confirm with product if ambiguous; default to reusing `PayDepositButton` inline on the success screen.
- **Whether `PayDepositButton` copy should differ** for accepted (after_approval) vs pre-accept (before_approval) — minor; resolve in U2.

## Sources & Research
Grounded in the codebase via a settlement-lifecycle trace (no external research needed — patterns are mature). Load-bearing anchors: `public-estimate-service.ts` (`approve()` deposit write 373-385; `getOrCreateDepositCheckoutUrl` 652-813; view assembly 626-636), `webhooks/routes.ts:933-960` (settlement, policy-agnostic), `EstimateApprovalPage.tsx` (CTA block 1040-1099, poll 604-625, `PayDepositButton` 1130-1190), `jobs/deposit-rule.ts` (`deriveDepositStatus`), and the existing tests `test/webhooks/checkout-session.test.ts:78-131` + `test/estimates/public-estimate-service.test.ts:634-828`.
