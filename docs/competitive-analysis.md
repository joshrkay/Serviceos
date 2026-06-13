# Competitive analysis — expansion-suite feature backlog (deferred)

> **⚠️ Superseded as positioning (2026-06-13).** The authoritative competitive
> positioning is now **`docs/PRD-launch-v1.md` §10**, and the post-launch
> sequencing is **§12 (Phased roadmap)**. The launch thesis is **run-by-text +
> collect** — an AI that runs the office so the owner never opens the app — and
> it **explicitly rejects feature parity as the strategy**: "the day we add the
> suite to win the comparison, we forfeit the category and become a worse
> Jobber." This document's original *"match table-stakes FSM features to win the
> ICP"* framing therefore no longer drives launch. **It is retained only as the
> deferred Phase-3 "expansion suite" backlog** — the menu we draw from *after*
> the wedge is won, and only as the PRD's expansion story, never the launch one.
> Treat the Top 10 below as a researched feature catalog (still-useful, with
> verified build state), not a roadmap. When in doubt, the PRD wins.

**Last revised:** 2026-05-31 · **Re-scoped to expansion backlog:** 2026-06-13
**Original framing (historical):** "Win the ICP, AI-first." Match the
*table-stakes* field-service features the smallest Jobber customers expect —
scheduling, payments, reviews, memberships — delivered the AI/SMS way; do
**not** chase ServiceTitan's enterprise surface (multi-location dispatch,
warehouse inventory, payroll, marketing automation). This framing is preserved
for context but is **subordinate to PRD §10/§12** — see the banner above.

## ⚠️ Verification correction (2026-05-31)

The first draft of this top-10 was derived from the May go-live audit docs.
A line-by-line check against the actual source showed the codebase is **much
more complete** than those docs implied. Verified status, so we build only
real gaps:

- **All launch blockers (Tier A #1) are resolved** in the current branch
  (B1–B10 + B12 done; B11's outbound-consent gate is built + unit-tested but
  correctly unwired because no outbound-calling path exists yet). The one
  loose end — the greenwashed per-module coverage gate — is now **enforced**
  in `pr-checks.yml` + `deploy.yml`.
- **#3 Online booking — DONE (shipped this work):** `routes/public-booking.ts`
  + `/book` page.
- **#4 Tiered good/better/best estimates + deposit + e-approval — ALREADY
  BUILT:** schema migrations 127/128/129 (`group_key`/`group_label`/
  `is_optional`/`is_default_selected`, `accepted_selection`); authoring in
  `web/.../forms/LineItemEditor.tsx`; customer selection + locked accept in
  `estimates/public-estimate-service.ts:209-271`; deposit checkout at
  `routes/public-estimates.ts` `/deposit-checkout`.
- **#7 Tech "on my way" + ETA text — ALREADY BUILT:**
  `notifications/delay-notifications.ts:134` ("on the way" + ETA), enqueued via
  `dispatch/routes.ts:163` (`enRouteCoordinator`, wired `app.ts:2646`).
- **#8 Proactive review requests — ALREADY BUILT:** `feedback-send` worker
  (DNC-gated post-job SMS) + review-gating in `routes/public-feedback.ts:128`
  (returns Google/Yelp URL on 4★+), `google_review_url` setting (migration
  124), surfaced in `web/.../FeedbackPage.tsx:150`.

**Genuine remaining gaps (verified):** customer **tips at checkout** (no
`tip`/`gratuity` anywhere — small, time-to-cash); **consumer financing**
handoff (Wisetack/Affirm — medium); **QuickBooks/accounting sync** (#10 — the
long pole). ACH is already covered via Stripe `automatic_payment_methods` +
`ach_return` reversal handling.

Re-audit verdicts (2026-05-31):
- **#6 Memberships — PARTIAL.** The `Agreement` model + `recurring-agreements-worker`
  handle recurrence → invoice/job generation, but the membership-engine depth is
  genuinely missing: **no auto-renew, no member pricing applied to
  estimates/invoices, no priority-booking flag, no recurring auto-charge of a
  saved card (`off_session`).** Real gap, but a multi-part build touching
  billing/estimates/invoices/booking.
- **#9 Unified inbox — DATA done; AI assist was missing → now SHIPPED (this work).**
  `customers/timeline.ts` already aggregates cross-channel history and
  `ConversationThread` renders threads, but there were **no AI-suggested replies**.
  Added `ai/tasks/suggest-reply-task.ts` + `POST /api/conversations/:id/suggest-reply`
  (brand-voiced draft, owner edits & sends — never auto-sent) and a "✨ Suggest
  reply" composer action. A dedicated cross-channel triage *inbox surface* (vs the
  current approval-queue "InboxPage") remains a follow-up.

The original top-10 below is kept for context; treat the verification block
above as authoritative.

## How to read this

The codebase is already a **broad, mature FSM platform** (135 migrations;
routes for customers, jobs, appointments, estimates, invoices, payments,
agreements, maintenance-contracts, leads, dispatch, time-tracking,
technician-location, telephony/voice, reputation/reviews, and a tokenized
customer portal). The competitive gaps are about **depth and AI-first
delivery**, plus a set of **launch-readiness blockers** that undermine trust
— not missing domains. Effort estimates are engineering-days for one agent.

---

## The Top 10 (expansion backlog — NOT launch scope)

> These are **deferred expansion-suite candidates**, drawn on only after the
> run-by-text wedge is won (PRD §12 Phase 3). They do **not** gate launch, and
> none of them is a reason to make the owner open the app. The build-state
> verifications below remain accurate and useful; the *prioritization* is
> historical and is superseded by the PRD's P0 set (text-approval spine →
> collections → HFCR metric → reliability gates).

### Tier A — Trust & money integrity (codebase)

**1. Close the launch-readiness blockers.** `GO-LIVE-READINESS.md` +
`BLOCKER-REMEDIATION-PLANS.md` enumerate 10: Stripe/Clerk webhook dedup is
in-memory only (`webhooks/routes.ts`); requests commit even on error
(`middleware/tenant-context.ts`); RLS enabled but not FORCEd on ~29 tables
(`db/schema.ts`); no payment audit events (`invoices/payment.ts`); no
DB-level double-booking constraint (`scheduling/feasibility.ts`); in-process
crons with no leader election + no graceful shutdown (`app.ts`); web proposal
approval sends a bare unauthenticated `fetch` (`AssistantPage.tsx`); public
estimate page can fall back to mock cross-tenant data
(`EstimateApprovalPage.tsx`). ServiceTitan/Jobber are trusted with money; we
can't claim parity while a restart can double-charge. **~3–5 days.**

**2. Real job queue + worker process.** `app.ts` runs reminders, recurring
agreements, digests, and review polling as in-process `setInterval` sweeps
(`app.ts:2804-2956`) — on every instance, so horizontal scaling duplicates
every send. Promote the existing `PgQueue`/`worker-registry` to a separate
worker process with single-flight gating, and decompose the 3,300-line
`app.ts`. **~3–4 days.**

### Tier B — Net-new competitive features (product, AI-first)

**3. AI online booking with real-time availability. ✅ STARTED (this PR).**
Jobber "Online Booking" / ServiceTitan's online scheduler is a flagship lead
funnel. We had the internals (`scheduling/booking-availability.ts:
findBookableSlots`/`isSlotFree`, the `create_booking` proposal, held
appointments) and a token-gated portal booking flow, but **no
unauthenticated public booking** for a prospect arriving from a shareable
link. This PR adds a public, token-less booking router (availability +
book), creating the customer, location, job, held appointment, and an
owner-approved `create_booking` proposal — fully inside the trust model.
**~2–3 days.**

**4. Tiered (good/better/best) estimates + deposit capture + e-approval.**
`estimates/` + `public-estimates.ts` exist; migration `127` already adds an
`estimate_line_item_options` table, so the data model is partly there.
ServiceTitan/Jobber sell multi-option quotes hard (proven revenue lift) and
take a deposit on acceptance. Finish option groups end-to-end on the public
approval page; capture a Stripe deposit on accept. **~3–4 days.**

**5. Payments depth — deposits, ACH, tips, auto-collect, financing.**
`payments/` + Stripe payment links + Connect exist. Time-to-cash is the
north-star. Add deposit-on-booking, ACH (lower fees), tip capture on the pay
page, saved-card auto-collect for memberships, and a consumer-financing
handoff. **~3–4 days.**

**6. Membership / recurring service-agreement engine.** `agreements/` +
`maintenance-contracts/` + `recurring-agreements-worker` exist. ServiceTitan's
membership engine is its signature high-margin retention tool. Deepen:
auto-renew, member pricing on estimates/invoices, a priority-booking flag
consumed by the booking flow (#3), and recurring card billing (#5).
**~3–5 days.**

**7. Technician GPS "on my way" + live ETA texts.** `technician-location.ts`
+ `dispatch/` + `scheduling/travel-time/` exist. Jobber/ServiceTitan both
auto-text the customer "your tech is on the way" with an ETA — the biggest
no-show reducer and a visible polish signal. Wire location → ETA →
brand-voice SMS on appointment start. **~2 days.**

**8. Proactive review requests.** `reputation/` is rich but
**monitoring-only** today (poll + draft responses). Jobber/ServiceTitan push
automated review *solicitation* after job completion. Add a post-completion
worker that proposes a review-request SMS (brand voice, DNC/compliance
gated). **~2 days.**

### Tier C — Depth buyers compare on

**9. Unified customer communication inbox (SMS + email + voice) with AI
drafts.** `conversations/` + `sms/` + `telephony/` exist but are siloed.
Competitors sell one threaded inbox per customer with templates + AI-suggested
replies. Thread all channels onto the customer timeline with one-tap AI
drafts. **~3–4 days.**

**10. Reporting depth + QuickBooks sync.** `reports/` is money-only
(`money-dashboard`, `revenue-by-source`, `tax-export`). Every Jobber/ServiceTitan
customer expects bookkeeping sync; QBO deep sync is currently deferred to
Wave 4. Add operational KPIs (jobs closed, won/lost, tech utilization) + a
QBO invoice/payment sync. **~4–5 days (QBO is the long pole).**

---

## Sequencing recommendation (superseded — see PRD §9 critical path)

> **Authoritative sequencing now lives in `docs/PRD-launch-v1.md` §9 (P0
> critical path)**: text-approval spine → finish collections → HFCR metric →
> reliability gates. The tiering below is retained as historical context for the
> *expansion* phase only.

Within the deferred expansion phase, the original recommendation was: Tier A
(#1, #2) money-integrity foundation first; Tier B customer-visible wins
(starting with online booking, #3); Tier C the "RFP checkbox" depth that closes
larger deals. Several Tier A blockers have since been resolved (see the
verification block above and PRD §10/Appendix for current build state). Revisit
this list only when planning Phase 3 expansion — and even then, every item is
judged against the wedge: *more hands-free dollars, never more screens.*
