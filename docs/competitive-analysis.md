# Competitive analysis — feature parity with ServiceTitan & Jobber

**Last revised:** 2026-05-31
**Framing:** "Win the ICP, AI-first." Keep the owner-operator focus from
`docs/PRD.md` v2.0. Match the *table-stakes* field-service features the
smallest Jobber customers expect — scheduling, payments, reviews,
memberships — delivered the AI/SMS way. We do **not** chase ServiceTitan's
enterprise surface (multi-location dispatch ops, warehouse inventory,
payroll, marketing automation); those are explicit anti-personas in the PRD.

## How to read this

The codebase is already a **broad, mature FSM platform** (135 migrations;
routes for customers, jobs, appointments, estimates, invoices, payments,
agreements, maintenance-contracts, leads, dispatch, time-tracking,
technician-location, telephony/voice, reputation/reviews, and a tokenized
customer portal). The competitive gaps are about **depth and AI-first
delivery**, plus a set of **launch-readiness blockers** that undermine trust
— not missing domains. Effort estimates are engineering-days for one agent.

---

## The Top 10 (prioritized)

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

## Sequencing recommendation

Tier A (#1, #2) is the foundation — sequence those via `/dispatch-story`
against the existing blocker remediation plans; nothing else is credible
while money integrity is at risk. Tier B ships the customer-visible
competitive wins, starting with online booking (#3, in progress). Tier C is
the "RFP checkbox" depth that closes larger deals.
