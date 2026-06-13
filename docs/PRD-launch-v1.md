# PRD — ServiceOS v1 ("AI Front Office") — Launch

**Author:** Founder / Product
**Date:** 2026-06-13
**Status:** Draft for review
**Eng baseline (verified 2026-06-13):** API production build clean (`tsc -p tsconfig.build.json`, 0 errors). Core engine — voice agent, 38-type proposal/approval system, billing, multi-tenant RLS (75/75 FORCE) — is built and largely hardened.

> This PRD is grounded in a file-level audit of the codebase. Every "current state"
> claim below carries a tag — **[WIRED]** (traced end-to-end, reachable in prod),
> **[EXISTS-UNVERIFIED]** (code exists, wiring unconfirmed), or **[STUB]**
> (placeholder/mock/dead code) — and a `file:line` citation in the appendix.

---

## 1. TL;DR

ServiceOS is an **AI front office for home-service businesses**. The owner does the
trade work; the AI answers the phone, books the job, drafts the quote and invoice,
and chases the money. The hard parts are already built: a deep voice agent and a
sophisticated human-in-the-loop autonomy engine. **The one thing missing is the
interface that matters most to a tradesperson who hates software: the ability to
run the whole business by text and voice without ever opening an app.** v1 builds
that spine, finishes collections, surfaces a dollar-denominated ROI number,
hardens trust for launch, and re-prices around the value (an employee, not a seat).

---

## 2. Vision & positioning

**One-liner:** *You do the work. The AI runs the business — it answers every call,
books the jobs, sends the invoices, and chases the money. You just show up and do
what you're great at.*

Tradespeople are excellent at their craft and reluctant, overloaded business
owners. The business side (quoting, scheduling, invoicing, chasing payment,
follow-up) is work they're bad at, hate, and do at 9pm. **They hate technology**, so
the incumbent answer — "here's powerful software, go learn it" — is the wrong
medicine. Jobber/Housecall Pro/ServiceTitan are systems of record the owner must
*operate*. ServiceOS is an **employee that operates the system for them.**

The strategic inversion: the rich app we've built stops being the user's workspace
and becomes the **AI's toolset**. The human interface is conversation (voice + text)
plus one-tap approvals. A business that runs from its text thread cannot easily
switch back to software that makes them do the work again.

---

## 3. Problem

- Owner-operators miss 25–40% of inbound calls (on a roof, under a sink, driving).
  Every missed call is a $300–$3,000 job that goes to whoever answers next.
- The back office is done badly or not at all: estimates delayed, invoices
  hand-written at night, **overdue invoices never chased** (cash left on the table).
- The tools that exist demand the owner become a software operator — exactly what
  this persona resists. Adoption dies at "log in and learn it."

---

## 4. Target user & personas

**ICP (assumption — confirm in O2):** single-location home-service businesses,
owner-operator + 1–10 technicians, in HVAC / plumbing / painting, US, English-first
(Spanish toggle exists in product).

| Persona | Role | Primary surface | What they want |
| --- | --- | --- | --- |
| **The Owner** ("Mike") | Buys & runs the business | Text + voice; app optional | Stop doing admin; get paid; never miss a job |
| **Office manager** (if any) | Day-to-day ops | Web app + text | Fewer dropped balls; less phone tag |
| **Technician** | Does the work | Mobile/text (status keywords) | Get the day's jobs; mark status without software |
| **Customer** | Books & pays | Phone, SMS, public links | Reach a human-like response; easy booking & payment |

---

## 5. Goals & non-goals

### Goals (v1)
- **G1 — Run-by-text:** the owner can receive, approve, edit, and reject the AI's
  proposed actions entirely by SMS/voice, without opening the app.
- **G2 — Prove ROI in dollars:** surface "money the AI made and collected for you"
  as the product's hero metric.
- **G3 — Close the cash loop:** finish automated, multi-step collections so the AI
  actually chases money to paid.
- **G4 — Earn trust:** zero cross-tenant leaks, zero double-charges, zero rogue AI
  actions. Launch-blocking.
- **G5 — Near-zero onboarding:** a tradesperson who hates tech can go live with a
  concierge/done-for-you path in minutes.
- **G6 — Price like an employee,** not a per-seat SaaS tool.

### Non-goals (explicitly out of v1)
- **NG1 — Customer self-serve portal.** Shell only today; cut.
- **NG2 — Standalone mobile technician app.** Presentation-only today; cut.
- **NG3 — Outbound AI calling.** No call-placement code exists; the DNC/consent gate
  is pre-built for a later release. Stays disabled.
- **NG4 — Suite-breadth parity with ServiceTitan.** The full ops suite stays in the
  product but is the *expansion* story, not the launch pitch.
- **NG5 — QuickBooks / deep third-party integrations.** Mock today; hide until wired.
- **NG6 — Making the owner operate a dashboard to get value.** Any login-required
  feature is expansion-only.

---

## 6. Success metrics

**North Star:** **Money Captured & Collected** — the dollar value of (a) jobs booked
from would-have-been-missed calls plus (b) invoices the AI collected, that the owner
did not personally chase.

| Metric | Target (first 90 days) |
| --- | --- |
| Activation: signup → first AI-captured booking | ≥ 60%, < 15 min median |
| **Run-by-text adoption:** % of approvals done via SMS/voice (not app) | ≥ 50% |
| North Star surfaced for active accounts | 100% |
| Collections recovery rate (overdue → paid via AI) | Baseline, then improve |
| Logo retention, month 1 → 3 | ≥ 85% |
| **Trust incidents** (leak / double-charge / rogue action) | **0** |

---

## 7. Current state vs. target (verified)

| Capability | Current state | Target for v1 |
| --- | --- | --- |
| Voice agent answers, qualifies, books | **[WIRED]** — 12 read skills + booking, lead auto-create, emergency escalation | Keep; sharpen missed-call/after-hours config |
| Owner approves proposals in **app** (single + batch ≤50) | **[WIRED]** | Keep as power-user surface |
| Owner approves by **voice** (capture-class, "say approve") | **[EXISTS-UNVERIFIED]** | Verify + generalize |
| Owner approves by **SMS reply** (YES/APPROVE/EDIT) | **[STUB] — does not exist** | **BUILD (Epic 0, headline)** |
| Proactive owner SMS on new proposal | Partial — unsupervised path `queue_and_sms`; vulnerability owner-cell-patch | Generalize to every proposal needing sign-off |
| Autonomy engine (trust tiers, class gating, thresholds) | **[WIRED]** — 38 types, mode-aware auto-approve | Tune + climb ladder (Epic 1) |
| Estimate AI-draft & send | **[WIRED]** — auto-approve draft at conf ≥0.9 + supervisor | Keep |
| Auto-invoice on job completion | **[WIRED]** — raises `draft_invoice` proposal | Keep; wire into text-approval |
| Stripe payment (public pay page) | **[WIRED]**; reconciliation **[EXISTS-UNVERIFIED]** | Verify reconciliation |
| Collections / dunning cadence | **One nudge only**; multi-step cadence is **[STUB] dead code** | **FINISH (Epic 2)** |
| ROI / "money captured" number | Not surfaced | **BUILD (Epic 3)** |
| Concierge onboarding | **[STUB]** — none; 6-step self-serve only | **BUILD (Epic 4)** |
| Tenant isolation (RLS FORCE) | **[WIRED]** — 75/75 in schema | Verify live in prod (Epic 5) |
| QuickBooks integration | **[STUB]** — pure mock (`setTimeout`) | Hide behind flag (Epic 6) |
| Money rendering in invoices UI | **[STUB-bug]** — `toLocaleString` drops cents | Fix (Epic 6) |
| Home greeting | **[STUB-bug]** — hardcoded "Good morning, Mike" | Fix (Epic 6) |
| Data flywheel (audit, transcripts, as-executed payloads) | **[WIRED]** — incl. `proposal_executions` correction data | Keep; persist analytics (Epic 1) |

---

## 8. Epics & detailed requirements

Priority: **P0** = launch-blocking, **P1** = launch-critical, **P2** = fast-follow.

### Epic 0 — The text-approval spine *(P0, headline)*

**Goal:** the owner runs the business from their text thread. The autonomy engine
already decides *what* needs sign-off; this epic adds the *channel*.

**Requirements**
- **0.1 — Proactive owner notification.** When a proposal lands in a state needing
  owner sign-off (`ready_for_review`, or auto-approved with an open undo window),
  send the owner a concise SMS: what the AI wants to do, the key facts, and the
  reply options. Generalize the existing `queue_and_sms` unsupervised path to all
  sign-off-needed proposals; respect quiet hours and rate limits.
- **0.2 — Inbound approval handler.** Register a new `KeywordHandler` (alongside
  STOP/START/tech-status) that maps owner replies → proposal actions:
  `YES`/`APPROVE` → approve; `NO`/`SKIP` → reject; `APPROVE ALL` → batch-approve the
  pending set; `EDIT <field> <value>` (stretch) → amend then approve.
- **0.3 — Threaded context.** Tie each owner SMS thread to the specific proposal(s)
  so a bare "yes" resolves unambiguously (most-recent-pending, with a short numbered
  list when multiple are open). Reuse the conversation-threading pattern from
  dropped-call recovery.
- **0.4 — Safety on the text channel.** Honor the existing action-class gates:
  capture-class fully text-approvable; **comms/money/irreversible actions require an
  explicit confirmation step** (e.g., reply `CONFIRM 1234`) rather than a bare "yes,"
  preserving today's "screen-tap for money" guarantee in a text-native way.
- **0.5 — Voice parity.** Verify and document the voice-approval path
  (`classifyVoiceApproval`) end-to-end so "say approve" reliably calls the approval
  service for capture-class proposals.

**Acceptance criteria**
- An owner with the app closed receives an SMS for a new `draft_invoice` proposal,
  replies `YES`, and the invoice draft is approved + executed (after undo window),
  with an audit event and a confirmation SMS.
- A `record_payment` (money-class) proposal cannot be approved by a bare "yes" — it
  requires the explicit confirm token.
- `APPROVE ALL` approves only the owner's currently-pending sign-off set (≤50),
  matching the web batch route's semantics.
- No regression to web/app approval surfaces.

**Dependencies:** autonomy engine (built), `sms/inbound-dispatch.ts` registry
(built), conversation threading (built).

---

### Epic 1 — Climb the autonomy ladder *(P1)*

**Goal:** move each business along *tap-on-screen → tap-in-text → AI-just-did-it* as
trust is earned. The engine exists; this is tuning, telemetry, and per-tenant
progression — not new infrastructure.

**Requirements**
- **1.1 — Persist proposal outcomes.** Wire the `ProposalOutcome` analytics
  (currently in-memory) to the database so approval/edit/reject rates per type and
  per tenant are queryable. This is the signal that justifies raising autonomy.
- **1.2 — Per-tenant trust dashboard (internal).** Surface, per business, the AI's
  approve-without-edit rate by proposal type, to inform threshold changes.
- **1.3 — Graduated thresholds.** Expose safe, owner-or-ops-controlled tuning of
  `autoApproveThreshold` per supervisor mode; default conservative.
- **1.4 — Autonomy ladder definition.** Document the explicit rung policy: which
  capture-class actions auto-approve under which conditions today, and the criteria
  to graduate a business to the next rung. **Money/irreversible never auto-execute
  (CLAUDE.md invariant).**

**Acceptance criteria**
- Proposal outcomes for a tenant are persisted and retrievable for a date range.
- Changing a tenant's threshold changes auto-approval behavior on the next proposal,
  with an audit trail.

---

### Epic 2 — Finish the cash loop (collections) *(P0)*

**Goal:** the AI actually chases money to paid — multi-step, automatic.

**Current state:** the overdue sweep fires **one** `notifyInvoiceOverdue` when an
invoice first crosses overdue. The full cadence selector `selectDueReminderSteps()`
and late-fee math exist but are **never called** — dead code.

**Requirements**
- **2.1 — Wire the cadence.** Have the overdue-invoice worker call
  `selectDueReminderSteps()` each run, send each due step via the transactional-comms
  service (SMS/email per config), and record a `DunningEvent` for idempotency.
- **2.2 — Late fees.** Wire `computeLateFeeCents()` into the sweep per tenant policy
  (grace days, flat/percent, cap) and reflect on the invoice.
- **2.3 — Owner loop-in.** Where policy requires, route a collections nudge to the
  owner via Epic 0 ("Hernandez is 14 days late on $840 — want me to add a late fee
  and send a final notice? Reply YES").
- **2.4 — Compliance.** Honor STOP/DNC for collections SMS (already wired).

**Acceptance criteria**
- An invoice that stays unpaid receives reminders at every configured offset (not
  just the first), idempotently, with late fees applied per policy.
- The Money-Captured metric (Epic 3) credits collected amounts.

---

### Epic 3 — Prove the ROI (the number) *(P0)*

**Goal:** make the value undeniable in dollars.

**Requirements**
- **3.1 — Attribution rule (O5).** Define "Money Captured & Collected": booked-job
  value attributed to would-have-been-missed calls (after-hours / no-answer /
  concurrent — derivable from voice session + lead data) **plus** AI-collected
  invoice amounts.
- **3.2 — Hero metric.** Replace the generic revenue/outstanding tiles on the home
  dashboard with one big dollar number + trend.
- **3.3 — Weekly owner summary.** Proactive SMS/email: "Your AI front office earned
  and collected $X this week." (Reinforces Epic 0; doubles as retention + referral.)
- **3.4 — Onboarding payoff.** After the live test call, show *"that call would have
  become this $X booked job and this draft invoice"* (ties to Epic 4).

**Acceptance criteria**
- Every active account shows a real, defensible Money-Captured number sourced from
  live data (voice sessions, leads, invoices, payments).

---

### Epic 4 — Concierge onboarding *(P1)*

**Goal:** a tradesperson who hates tech goes live with near-zero effort.

**Current state:** a 6-step self-serve wizard (identity → pack → phone → billing →
ai_check → test_call), fully self-serve, **no done-for-you path**.

**Requirements**
- **4.1 — Concierge path.** A guided/assisted setup (human-assisted or AI-driven over
  a call) that completes identity, pack, phone provisioning, and billing on the
  owner's behalf; the owner confirms by voice/text.
- **4.2 — Reduce required taps.** Pre-fill from a short intake; defer everything
  non-essential to first value (a booked test call).
- **4.3 — Miracle moment.** End onboarding on the Epic 3.4 payoff.

**Acceptance criteria**
- A new owner can reach a provisioned number + first captured booking without
  completing the full self-serve wizard unaided.

---

### Epic 5 — Trust & reliability gates (the 5-day plan) *(P0)*

**Goal:** safe to put a paying customer — who is approving by text, half-looking — on
the system. Trust is the product.

**Requirements (each a launch gate)**
- **5.1 — Green CI on HEAD:** all suites run, nothing skipped (Playwright E2E needs
  `E2E_CLERK_SECRET_KEY`); decide gating vs advisory on coverage.
- **5.2 — Prod config:** every fail-closed secret set — `TRANSCRIPT_ENCRYPTION_KEY`,
  durable webhook repo, `SENTRY_DSN`, Clerk/Stripe webhook secrets,
  `VITE_STRIPE_PUBLISHABLE_KEY`, the 11 qa-matrix secrets.
- **5.3 — Prod migration verification:** applied-vs-expected diff = 0; webhook
  idempotency index present; **RLS FORCE confirmed live** (zero tables with
  `relforcerowsecurity = false`); double-booking EXCLUDE constraint present.
- **5.4 — Money renders correctly** (see Epic 6.2) — launch-blocking because it's
  customer-facing money.
- **5.5 — `/ready` returns 503 on real DB outage** (today returns `degraded`).
- **5.6 — Two-tenant isolation proven by repeatable test; webhook-replay drill shows
  no double-charge; single-instance graceful shutdown verified.**

**Acceptance criteria:** all six gates green, evidenced (CI run id, query outputs,
test artifacts). See `docs/PRD-launch-v1.md` companion checklist in §11.

---

### Epic 6 — Credibility polish *(P1)*

- **6.1 — Fix hardcoded greeting** "Good morning, Mike" → real user
  (`HomePage.tsx:323`).
- **6.2 — Money formatter** — route all `InvoicesPage.tsx` amounts (9 sites) through
  the correct cents formatter; standardize across web.
- **6.3 — Hide QuickBooks** (and other mock integrations) behind a feature flag until
  wired; remove "coming soon" no-ops from the launch surface.
- **6.4 — Delete dead-but-dangerous code:** `routes/proposals-execute.ts` (bypasses
  undo/idempotency, currently unmounted), unsafe `db/client.ts` `setTenantContext`.
- **6.5 — Web auth-fetch consolidation** on `useApiClient`; add router `errorElement`
  to prevent white-screens on public pages.
- **6.6 — Verify review-response Google reply** is wired at the composition root (else
  it silently no-ops).

---

### Epic 7 — Pricing & positioning *(P1, GTM)*

- **7.1 — Reposition** all surfaces around "AI front office / you do the work, the AI
  runs the business."
- **7.2 — Employee pricing:** a flat monthly tier framed against a ~$3k/mo
  receptionist, and/or a per-captured-booking component — not per-seat. (Anchor TBD,
  O3.)
- **7.3 — In-product ROI framing:** Money-Captured ≫ price, shown where the owner
  sees the bill.

---

## 9. Key user journeys

**J1 — Missed call → booked job (run-by-text):**
After-hours call → AI answers, qualifies, drafts `create_appointment` → owner gets
SMS "New job: Jensen, water heater, Thu 2pm, $X. Reply YES to confirm" → owner texts
`YES` → booked, customer confirmed, audit logged. *(Epic 0 + existing voice + booking.)*

**J2 — Job done → paid:**
Tech marks job complete → auto-invoice drafts → owner SMS "Invoice $880 for Oak St.
Send it? YES" → `YES` → invoice sent → customer pays via link → if unpaid, AI runs
the dunning cadence → owner sees it in Money-Captured. *(Epic 0 + 2 + 3.)*

**J3 — Tech out sick:**
Tech texts `OUT` → AI drafts reschedules for the day's jobs with customer messages →
owner texts `APPROVE ALL` → customers notified. *(Existing tech-status + Epic 0 batch.)*

**J4 — Onboarding miracle:**
Concierge setup → live test call → "that call would've become this $X job + invoice."
*(Epic 4 + 3.4.)*

---

## 10. Pricing & packaging (proposal, see O3)

- Frame: **an employee, cheaper than a receptionist.** Avoid per-seat anchoring.
- Candidate: flat "AI front office" monthly + optional per-captured-booking; ROI
  surfaced in-product so price is self-justifying.
- Free trial preserved; billing already wired via Stripe in onboarding.

## 11. Launch criteria (Definition of Done)

- [ ] Epic 0 spine live: proactive SMS + reply-to-approve, with money-class confirm
- [ ] Epic 2 cadence wired; collections chase to paid
- [ ] Epic 3 Money-Captured live for every account
- [ ] Epic 5 all six trust gates green (CI, secrets, migrations, money-render,
      readiness 503, isolation/replay/shutdown)
- [ ] Epic 6 credibility fixes shipped; QuickBooks hidden
- [ ] Pricing live (Epic 7)
- [ ] 5 design-partner businesses on real call traffic, **zero trust incidents**

## 12. Milestones (assumption: ~4 weeks; confirm in O6)

- **Week 1 — Trust + credibility:** Epic 5 + Epic 6. Outcome: safe to onboard a payer.
- **Week 2 — Run-by-text + cash:** Epic 0 + Epic 2. Outcome: owner operates by text;
  AI collects.
- **Week 3 — Prove it + concierge:** Epic 3 + Epic 4; land 5 design partners.
- **Week 4 — Position, price, GA:** Epic 7; watch North Star; open chosen channel.

## 13. Go-to-market / distribution (must-answer — O1)

Pick and test **one** channel before GA spend: (A) integrate on top of incumbents
(don't rip-and-replace), (B) partner with who already sells to these trades
(distributors, franchises, associations), (C) multi-location land-and-expand.

## 14. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Trust incident (leak / double-charge / rogue AI) | Epic 5 non-negotiable; isolation proven by test; money-class needs explicit text confirm (Epic 0.4) |
| Owner approves blind by text and the AI errs | Keep undo window; money/irreversible never auto-execute; confirm tokens; conservative thresholds |
| Collections SMS → compliance complaint | STOP/DNC honored (wired); quiet hours; per-tenant policy |
| No distribution → great product, no users | Decide O1 before GA spend |
| Priced like SaaS → undersells value | Epic 7 employee pricing |
| Suite breadth dilutes pitch | Lead with the wedge; suite is expansion-only |

## 15. Open questions

- **O1 —** Which distribution channel do we test first? *(blocks GA spend)*
- **O2 —** Lead vertical for launch — one trade or all three?
- **O3 —** Pricing model + anchor number (flat employee fee, per-booking, hybrid)?
- **O4 —** Who owns prod-access verification (migrations/secrets/isolation)?
  *(Owner confirmed: founder runs prod checks.)*
- **O5 —** Money-Captured attribution rule — exact definition of "would have been
  missed" and how collected amounts are credited?
- **O6 —** Is the ~4-week timeline acceptable, or is there a hard launch date?

---

## Appendix A — Verified current-state map (citations)

**Interaction & approval**
- Web approval: `routes/proposals.ts:187-232` (single + batch ≤50) — [WIRED]
- Voice approval (capture-class): `ai/tts/readback.ts:19-51,144-156` — [EXISTS-UNVERIFIED]
- Inbound SMS registry: `sms/inbound-dispatch.ts:49-92`; handlers registered
  `app.ts:654-655` (STOP/START) + tech-status bootstrap — [WIRED]
- **No SMS approve handler** (searched `sms/`, `compliance/`) — [STUB]
- Proactive owner SMS: `voice/triage/owner-cell-patch.ts`; unsupervised
  `queue_and_sms` `app.ts:2558,2566`, `proposals/auto-approve.ts:68` — [WIRED]
- Screen-gating by class: `readback.ts` (`isVoiceApprovable` = capture only);
  send_invoice/send_estimate/record_payment explicit screen-tap — [WIRED]

**Autonomy engine**
- 38 proposal types + classes: `proposals/proposal.ts:24-65,223-320` — [WIRED]
- Initial-status decision: `proposal.ts:337-406` — [WIRED]
- Thresholds (0.9 / 0.92 / 0.95, tenant override): `proposals/auto-approve.ts:76-95` — [WIRED]
- Supervisor presence: `proposals/supervisor-presence.ts:92-122` — [WIRED]
- Undo window 5s + idempotency lock: `execution/lifecycle.ts:40-63`,
  `execution/executor.ts:88-96`, `execution/idempotency-lock.ts:24-37` — [WIRED]
- Execution registry (28+ handlers): `execution/handlers.ts:413-559` — [WIRED];
  onboarding_* (5) + voice_clarification no-handler — [STUB by design]
- Outcome analytics: `proposals/analytics.ts:4-80` — [EXISTS-UNVERIFIED] (in-memory)

**Money loop**
- Estimate AI-draft + auto-approve ≥0.9: `ai/tasks/estimate-task.ts:100-125` — [WIRED]
- Auto-invoice on completion (P20-001): `invoices/auto-invoice-on-completion.ts:47-130` — [WIRED]
- Stripe pay: `routes/public-payments.ts:52-100`, `payments/stripe-payment-intent.ts:56-107` — [WIRED]; reconciliation — [EXISTS-UNVERIFIED]
- Overdue sweep sends ONE nudge: `workers/overdue-invoice-worker.ts:110` — [WIRED]
- Multi-step cadence selector uncalled: `invoices/dunning-schedule.ts:35-60` — [STUB/dead code]
- Late fee math: `invoices/late-fee.ts:47-75` — [EXISTS-UNVERIFIED]

**Voice in-call**
- 12 lookup skills + mutation skills + emergency escalation + lead auto-create:
  `ai/skills/*`, `ai/orchestration/intent-classifier.ts`, `ai/voice-turn/*` — [WIRED]
- Dropped-call SMS recovery: `sms/recovery/dropped-call-handler.ts` — [WIRED]

**Data flywheel**
- audit_events: `audit/audit.ts:4-35` — [WIRED]
- Voice capture (attempts/versions/intent/command): `voice/pg-voice-audit.ts` — [WIRED]
- proposal_executions (as-executed payload, correction data): `proposals/proposal-execution.ts:31-44` — [WIRED]

**Stubs / bugs to flag**
- QuickBooks mock: `web/src/components/settings/QuickBooksModal.tsx:23-26` — [STUB]
- Language voice overrides: `web/src/pages/settings/LanguageSettings.tsx:5-7` — [STUB]
- Review-response Google reply conditional: `proposals/execution/review-response-handler.ts:200-206` — [WIRED w/ no-op fallback]
- "Good morning, Mike": `web/src/components/home/HomePage.tsx:323` — [STUB-bug]
- Money render drops cents: `web/src/components/invoices/InvoicesPage.tsx` (256,257,275,376,552,723,735,744,868) — [STUB-bug]
- DB health `degraded` not `down`: `app.ts:523` — [bug]

**Reliability (verified 2026-06-13)**
- API prod build clean; RLS 75/75 FORCE; webhook idempotency fail-closed
  (`webhooks/routes.ts:182`); `/metrics` auth-gated (`app.ts:406,553`); transcript
  AES-256-GCM (`workers/transcription.ts`); DNC consent gate built but **no outbound
  calling exists** (`voice/outbound-consent.ts`; no `calls.create`).

## Appendix B — Onboarding steps (current)

`identity → pack → phone → billing → ai_check → test_call`, polled via
`GET /api/onboarding/status` (no progress table; derived from live entities). Fully
self-serve; **no concierge path** (`routes/onboarding.ts`, `web/.../onboarding/v2/`).
