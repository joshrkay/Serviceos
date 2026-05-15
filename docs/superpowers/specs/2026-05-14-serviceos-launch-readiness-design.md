# ServiceOS Launch Readiness — Design

**Date:** 2026-05-14
**Branch:** `main`
**Status:** Draft for review

---

## 1. Goal & non-goals

**Goal:** Define the complete, launch-ready product surface for ServiceOS — a voice-first operating system that lets a solo trades owner-operator run their business without really running their business. This spec takes the ~85%-built codebase to a **full public, self-serve launch** by deciding, section by section, the *minimum credible version* of every surface a real tradesperson touches.

**The product promise:** A solo HVAC or plumbing operator points their business phone at ServiceOS. The AI answers calls, books jobs, drafts estimates and invoices, chases payments, and sends customer messages — and every action that changes money or the schedule waits in an approval inbox for one tap. The owner does the trade work; the software runs the business.

**Target user:** Solo owner-operator (one person — they answer the phone, do the job, and send the invoice). Not crews, not dispatchers, not multi-tech shops.

**The core loop is one loop:** "running the business" (scheduling, invoicing, comms) and "getting more business" (leads, reviews, re-engagement) are not two products — they're one continuous loop the AI runs and the owner approves.

**Launch shape:** Full public launch, fully self-serve — a tradesperson gets from landing page to a live voice agent with no human in the loop.

**North-star metric:** **Time given back** — hours the owner did not spend on the phone, texting, chasing, and typing. Shown with a dollar equivalent.

**Non-goals (explicitly out of scope for launch):**
- **Parts & inventory management** — the one feature area explicitly cut. No stock tracking, no parts ordering, no supplier integration.
- **Crews / multi-technician / dispatch** — single owner-operator only at the product surface. No crew assignment, no dispatch board. (The underlying data model stays multi-technician — already built — but launch exposes only the owner.)
- **Full accounting** — no P&L statements, no double-entry, no payroll. Bookkeeping is *lightweight* (visibility + tax export only).
- **Google Calendar sync** — not a launch *requirement*; launch availability is working-hours-and-gaps only. (Note: sync already exists in the codebase — it can stay as a carry-over, but it is not on the launch critical path.)
- **Conversational (barge-in) in-app voice** — launch ships push-to-talk; the architecture stays conversational-ready.
- **Multi-tenant team features, bilingual voice, route optimization** — not in launch scope.

---

## 2. Approach

**Chosen approach: one launch, ruthless per-section MVP.**

Rather than a phased rollout or a pilot cohort, ServiceOS ships as a single full public launch. Every section below is scoped to its *minimum credible version* — the smallest build that a real paying tradesperson would find genuinely usable, with no embarrassing gap. Anything beyond that minimum is deferred. The discipline: each section earns its launch-day surface area or it waits.

---

## 3. Founding decisions (locked — enforced by `decisions.test.ts`)

This spec operates inside the 12 founding decisions. The ones that shape it most:

- **D-004 — Proposal-first AI safety.** The AI never writes directly to customers, jobs, estimates, invoices, or leads. Every state change is a typed, Zod-validated proposal that a human approves. The owner chose "approve everything" — this is absolute.
- **D-003 — Integer cents.** All money is integer cents, never floating point. All financial math goes through the shared billing engine.
- **D-005 — Tiered LLM gateway.** All AI calls route through the LLM gateway.
- **D-008 — Vertical packs.** HVAC and plumbing ship as vertical packs that seed job types, flat-rate line items, message templates, and triage rules.
- **D-009 — Stripe payment links.** Customer payments are collected via Stripe payment links.
- **P0-014 webhook base** for all external webhook handlers (Stripe, Twilio).
- **P0-009 async worker pattern** for background jobs.

---

## 4. The eleven sections

Each section states its **minimum credible version**, the **fork decision** made for launch, and a **current state → gap** assessment — what the existing codebase already provides versus what launch still requires. The gap assessments come from a section-by-section audit of the live codebase: **this is a delta against existing code, not a greenfield build.** Gap sizes (small / moderate / large) reflect remaining build effort, not importance.

### Section 1 — Inbound Voice Agent

The AI that answers the business phone.

**Minimum credible version:** Twilio telephony + Media Streams; OpenAI Whisper STT + OpenAI TTS in production (Deepgram/ElevenLabs streaming stays scaffolded for post-launch). The 6-state calling-agent FSM handles identify caller → understand need → check availability → book → confirm → wrap. The agent can answer questions, capture leads, and book jobs.

**Fork decision — booking model: held slot + async approval.** When the agent books, it places a **tentative hold** on a real calendar slot and tells the caller a time. The booking becomes a `CreateBooking` proposal routed to the owner's approval inbox. Approving confirms the slot; rejecting releases it. The caller gets a real time commitment; the owner keeps D-004 control. (Held slots are first-class in Section 5.)

**Current state → gap (MODERATE).** *Built:* the 6-state calling-agent FSM (`state-machine.ts`, `transitions.ts`), Twilio adapter + Media Streams server (μ-law codec, WebSocket), Whisper STT + OpenAI TTS in production, intent classifier, 8+ lookup skills, and the intent → `create_proposal` side-effect pipeline. *Scaffolded:* Deepgram/ElevenLabs streaming interfaces exist but are not production-wired. *Missing — the held-slot model entirely:* no `tentative` / `hold_pending_approval` appointment status, no slot-reservation or hold-expiry mechanism, no release-on-rejection logic, and no distinct `CreateBooking` proposal type (today the agent emits `create_appointment` and no slot is actually held between "you're booked" and approval). **The gap is a schema migration + a new proposal type + a hold lifecycle — not the voice stack itself.**

### Section 2 — In-App Voice Assistant

The voice interface the owner uses to drive the business.

**Minimum credible version:** The owner speaks commands ("send Maria an estimate for the water heater swap," "what's on tomorrow," "log $240 at the supply house for the Johnson job"). Commands that change state become proposals. The assistant can query (read) and propose (write) across every section.

**Fork decision — interaction model: push-to-talk now, conversational-ready.** Launch ships push-to-talk (tap, speak, release). The underlying architecture (streaming STT/TTS interfaces) stays ready for conversational barge-in, but that's post-launch. Reduces launch surface without painting the architecture into a corner.

**Current state → gap (SMALL for launch).** *Built:* the push-to-talk `VoiceRecorder` UI with a full recording state machine, the `InAppAdapter` sharing the same FSM as telephony, intent classification, TTS playback, and a transcript editor. *Missing for launch — minor:* the owner-command grammar is generic (LLM-inferred intent, no domain slot-filling), and there is no voice-based proposal approval (approval is screen-tap only). *Deferred (conversational-ready):* streaming STT, streaming TTS, and barge-in are scaffolded but unwired — explicitly post-launch. **The launch target — push-to-talk — is essentially already met; the gap is polish, not build.**

### Section 3 — The Approval Inbox

Where every AI proposal waits for the owner's tap. The control center of the whole product.

**Minimum credible version:** A unified inbox of typed proposals (bookings, estimates, invoices, reschedules, cancellations, marketing messages, expense logs). Each shows what will happen, in plain language, with approve / reject / edit. Approval triggers deterministic execution with idempotency keys.

**Fork decision — delivery model: hybrid push/queue.** Urgent, time-sensitive proposals (a held slot expiring, a caller waiting) push immediately (notification). Everything else queues quietly for review at the owner's convenience. The owner is not interrupted for routine work but never misses something that's actually time-critical.

**Current state → gap (MODERATE).** *Built:* 19 of 21 proposal types with Zod contracts, the proposal executor with an idempotency guard, the auto-approval decision engine (D-003 action-classes, mode-aware thresholds), and the background execution worker. *Partial:* the approval UI is **scattered** across `ConversationalIntakePage`, `ConfirmProposalDialog`, and `InvoiceProposalActions` — there is no unified inbox page. *Missing:* proposal-specific push-vs-queue routing logic (notification infra exists but isn't wired to proposal urgency), and the `expense_log` + `marketing_message` proposal types (required by Sections 8 and 7). **The gap is a unified inbox UI + 2 new proposal types + push/queue classification — the executor and contracts are solid.**

### Section 4 — Customers & Leads

The contact record and the top of the funnel.

**Minimum credible version:** One customer record — multiple service locations, notes, linked activity history (jobs, messages, money). Auto-created from voice via a `CreateCustomer` proposal. Phone-based deduplication. Fast search. Lead sources: public `/intake` form, non-converting calls, manual add, referral note.

**Fork decision — lead model: keep the existing 6-stage pipeline.** The codebase already has a working lead model with 6 stages (`new / contacted / qualified / quoted / won / lost`) and a drag-drop kanban `LeadList` UI. Decision: **keep it as-is** — it's built, it works, and tearing it out would be net-negative effort. Leads stay a distinct entity from customers; the existing `convertToCustomer()` bridges them. The "light" instinct is satisfied by not *adding* pipeline ceremony — not by removing what already exists.

**Current state → gap (SMALL — smaller than the broad audit estimated).** *Built:* the Customer and Lead models (6-stage pipeline + kanban `LeadList` UI — kept as-is per the fork decision), phone-based dedup, lead → customer conversion, the linked activity timeline, multiple service locations, fast search, the public `/intake` **API** endpoint, **and the public `/intake` web form page itself** — `packages/web/src/components/customer/IntakeFormPage.tsx` is a complete 4-step wizard (attribution capture, honeypot, full submit), already wired into the router as a public fullscreen route. (The broad section-by-section audit missed it; a focused explore for this plan found it.) *Missing:* (1) **test coverage** — its three sibling public pages all have `.test.tsx` files, `IntakeFormPage` does not; (2) **real tenant branding** — the business header (name, review count, phone) is hardcoded mock data ("Ortega HVAC & Services"), and there is no public tenant-info endpoint to load the real tenant's identity from the `?t=<tenantId>` param; (3) possibly **vertical-pack-driven service types** (currently hardcoded HVAC/Plumbing/Painting). **§4 is essentially done — the remaining work is test coverage + wiring the form to real tenant data, not building a page.**

### Section 5 — Jobs & Scheduling

The spine. Tightly coupled to Section 7 (every schedule change is a customer-comms trigger).

**Minimum credible version:** Job entity = customer + service location + vertical-pack job type + status (`unscheduled → scheduled → in_progress → complete → invoiced`) + time window + line items/notes. Single owner-operator calendar (day/week view) — the owner is the only resource *at the product surface*; the underlying appointment model stays multi-technician (already built), with owner-only enforced by convention (one technician row per tenant), not a schema change. Held slots are first-class: a `hold_pending_approval` flag, visually distinct on the calendar, cleared on approval / released on rejection. Lightweight buffer awareness (a default buffer between jobs, not route optimization). Every schedule mutation emits an event for Section 7. Reschedule and cancel are themselves proposals.

**Fork decision — availability model: working hours + gaps.** The owner sets weekly working hours and a default job buffer once during onboarding. Availability = any gap in working hours not filled by a job or buffer. The voice agent offers the next 2–3 open windows. No external calendar dependency at launch — Google Calendar sync is a post-launch fast-follow.

**Current state → gap (MODERATE).** *Built:* Job and Appointment models with state machines, `job_timeline_events` with audit emission, working-hours and unavailable-block entities, and — already shipped — Google Calendar sync (which this spec had deferred; it is a free carry-over, not launch-blocking either way). *Resolved:* the appointment model stays multi-technician as-is — owner-only is a convention (one technician per tenant), not a schema change. *Missing:* held-slot first-class support (no `hold_pending_approval` flag, no release/clear logic), buffer-aware availability computation (no `default_buffer_minutes`, no gap-finding service that nets out buffers), and event emission on reschedule/cancel proposal execution. **The gap is the held-slot flag + a buffer-aware availability service + reschedule/cancel events — the calendar and working-hours substrate exists.**

### Section 6 — Time-to-Cash Chain (estimates → invoices → payment)

The money pipeline. Constrained by D-003 (integer cents), D-009 (Stripe payment links), shared billing engine.

**Minimum credible version:** Estimate = vertical-pack-aware line items (labor, parts, flat-rate book), subtotal, tax, total — all integer cents via the billing engine, created as a proposal. Invoice = same structure plus a Stripe payment link. Stripe webhook (on the P0-014 base) marks paid, flips job state, emits an audit event, notifies the owner. Every job carries a visible money state (`no estimate / estimate sent / accepted / invoiced / paid / overdue`). Overdue emits an event for Section 7.

**Fork decision — estimate workflow: full estimate → invoice chain.** Estimates are first-class — created, sent, customer can accept, then one-click convert to invoice with no re-keying of line items. Invoice-direct-off-a-completed-job is also supported (not every job needs an estimate). Both paths ship at launch. Trades that quote before working would feel the gap immediately if estimates were cut.

**Current state → gap (MODERATE).** *Built:* Estimate and Invoice models, the shared billing engine, integer-cents line items, Stripe payment-link generation, Stripe webhook signature-verification + parsing, payment recording, and the estimate → invoice conversion handler. *Built — corrected by a focused codebase explore (2026-05-14); the broad audit undersold these two:* (1) **the Stripe `checkout.session.completed` webhook is wired end-to-end** — `webhooks/routes.ts` verifies the signature, dedups on the P0-014 base, and on a paid session calls `recordPayment`, which marks the invoice `paid` / `partially_paid` and recomputes balances; it already handles overpayment (caps to `amountDueCents`) and already-settled invoices (idempotent no-op). The "wiring not confirmed end-to-end" claim was wrong for the invoice side. (2) **the `reschedule_appointment` and `cancel_appointment` execution handlers are fully implemented, not stubs** — `RescheduleAppointmentExecutionHandler` does time validation, a staleness check, technician-conflict detection, the appointment update, and a dispatch event; `CancelAppointmentExecutionHandler` does a staleness check, idempotent re-cancel, a terminal-state guard, the status update, and a dispatch event. *Missing:* a denormalized **job money-state** — `Job` carries deposit-specific money fields (`depositRequiredCents` / `depositPaidCents` / `depositStatus`) but no overall `no_estimate / estimate_sent / estimate_accepted / invoiced / paid / overdue` state — plus the rollup logic that maintains it; overdue detection + event emission (nothing sweeps invoices past `dueDate`); and the webhook's "flip job state + emit audit event" step, which can't exist until the money-state field does (the webhook updates the *invoice* but has no job money-state to roll up to). **The remaining gap is the job money-state field + its rollup wiring + an overdue-detection worker + the narrow webhook → job-state hook — the money primitives, the invoice-side webhook wiring, and the reschedule/cancel handlers are all already built.**

### Section 7 — Customer Communications

Joined at the hip with scheduling. Two layers.

**Minimum credible version — Layer A (transactional, automatic):** Event-driven off Sections 5 & 6 — job booked → confirmation; T-24h → reminder; reschedule → change notice; cancel → cancellation notice; estimate/invoice sent → matching message; payment received → receipt; invoice overdue → nudge. These fire automatically (not proposals — the owner already approved the underlying action). SMS-first via Twilio, email fallback, delivered through Section 3's hybrid model.

**Minimum credible version — Layer B (marketing):** Review request after a paid job; re-engagement of dormant customers.

**Fork decision — marketing automation: AI-suggested, owner-approved.** The AI watches for triggers (job paid, customer dormant 9mo+) and drafts a message into the approval inbox. Nothing marketing-related sends without a tap. D-004 holds cleanly — no automated marketing sends. Plus: a single unified message log per customer, per-vertical templates, the owner's business identity on every send, and a hard STOP/opt-out path (Twilio compliance — non-negotiable for launch).

**Current state → gap (MODERATE).** *Built:* Twilio SMS + SendGrid email delivery, branded templates, the `message_dispatches` unified log, send idempotency, and the job-booked confirmation notifier. *Missing:* the T-24h reminder scheduler (no delay queue for appointment reminders — only an in-service-delay notifier exists), reschedule / cancel / payment-receipt notifications (those proposals execute but fire no message), overdue dunning, **STOP / opt-out tracking** (only an `sms_consent` boolean — no STOP-reply webhook handler; a launch-compliance must-have), and per-vertical templates. **The gap is a scheduled-send mechanism + four event → message wirings + STOP compliance + vertical templates — the send/log infrastructure exists.**

### Section 8 — Money Dashboard & Exports

Lightweight bookkeeping — visibility and tax-prep, not accounting software.

**Minimum credible version:** A money dashboard rolling up from job money-states (this month's revenue from paid invoices, outstanding, overdue, trend vs. last month) — no separate ledger. Income is automatic from paid invoices. Tax-ready date-range export (CSV/PDF) — income + expenses by category and by job — the packet the owner hands their accountant.

**Fork decision — expense capture: voice-logged expenses + export.** The owner logs expenses by voice ("$240 at the supply house for the Johnson job") via a `LogExpense` proposal — categorized, optionally job-linked. Receipt photo attach is nice-to-have, not required for launch. The export covers both income and expenses, so the accountant gets a complete picture. Fits the voice-first promise. No P&L, double-entry, payroll, or inventory.

**Current state → gap (LARGE).** *Built:* the payments/invoices data model and a revenue-by-source report (with a web page). *Missing entirely:* the expense subsystem (no `expenses` table, no `LogExpense` proposal type, no UI, no job-linking, no categorization), the money-dashboard summary cards (this-month revenue / outstanding / overdue / trend — only the historical source report exists), and any CSV/PDF export endpoint. **This is the largest build of the eleven: the expense subsystem end-to-end + the dashboard rollup + the tax export are all net-new.**

### Section 9 — The "Time Given Back" Surface

Where the product proves it delivered on its promise. The north-star, made visible.

**Minimum credible version:** A home-screen headline — estimated time given back this week — computed from real events, not vibes. Each automated action carries a small, fixed, versioned time-credit (call handled ≈ X min, confirmation sent ≈ Y min, invoice generated ≈ Z min, payment reconciled, reminder sent). Sum the credits over the week. Backed by a legible receipt: "4 calls answered, 12 confirmations sent, 7 invoices created, 3 payments chased." First thing the owner sees on opening the app; today's jobs and pending approvals sit below it. Credits are tunable constants, versioned, so the estimate can be recalibrated post-launch safely.

**Fork decision — framing: time + money equivalent.** The headline shows hours **and** a dollar value (hours × the owner's hourly rate, captured in onboarding) — "6.5 hours given back ≈ $480." More visceral than hours alone. Calibrate credits conservatively so the dollar figure stays credible.

**Current state → gap (LARGE).** *Built:* the home screen (`HomePage.tsx`, a full operational dashboard) and the audit-event infrastructure that already records automated actions. *Missing entirely:* the time-credit concept (no versioned per-action constants), the weekly aggregation, the hourly-rate × time dollar framing, the receipt, and the home-screen widget. **The entire Time-Given-Back surface is net-new — but the event substrate to compute it from already exists, so this is feature work on a solid base, not plumbing.**

### Section 10 — Onboarding & Self-Serve Setup

The gate between "signed up" and "the business is running." Fully self-serve, no human in the loop.

**Minimum credible version — the setup chain:**
1. **Sign up** — Clerk auth; the Clerk webhook bootstraps the tenant (tenant_id + RLS — already built).
2. **Business identity** — name, trade, service area, business hours + job buffer (feeds §5), hourly rate (feeds §9). One short form.
3. **Pick a vertical pack** — HVAC or plumbing; seeds job types, flat-rate line items, message templates, triage rules.
4. **Provision a phone number** — Twilio number purchased and wired to the inbound voice agent; owner can forward their existing business line to it. **Critical-path step — no number, no product.**
5. **Subscribe** — ServiceOS subscription billing via Stripe.
6. **Go live** — a test call confirms the agent answers, then the home screen.

A visible setup checklist survives interruption (owner can close the app at step 4 and resume) with a clear "you're live" moment.

**Fork decision — subscription gate: free trial, card required.** The owner enters a card during onboarding but isn't charged until a 14-day trial ends. The agent goes live immediately. Standard SaaS motion — low friction to value, card-on-file makes trial-to-paid conversion automatic. Stripe subscription with a trial period.

**Current state → gap (MODERATE).** *Built (fragmented):* Clerk auth + the webhook tenant-bootstrap, the business-identity form (UI + API), vertical-pack seeding, the Twilio provisioning worker, and Stripe subscription-billing infrastructure (`BillingService`, portal sessions, cached subscription columns on `tenants`). *Missing:* a resumable / interruptible setup checklist, a vertical-pack **picker** UI (packs seed on startup but the user can't browse and choose them), Twilio-readiness feedback surfaced into the onboarding UI, **14-day trial enforcement** on completion (billing is currently optional, not a gate), and a go-live test-call step. **The gap is integration, not invention: stitch the existing pieces into one guided, resumable flow and add the trial gate.**

### Section 11 — Launch Quality Bar

Not a feature — the gate. The product is voice-first and money-handling, so failure modes are loud.

**Minimum credible version:**
- **Multi-instance execution safety** — the proposal executor must be concurrency-safe. Idempotency keys on every proposal execution, plus a guard that the same proposal cannot execute twice even if two workers pick it up. Highest-risk area — it's where money moves.
- **Critical-path smoke tests** — automated, run on every deploy: inbound call → held slot → approval → confirmation sent; estimate → invoice → Stripe link → webhook → paid. If either chain breaks, the deploy is blocked.
- **Voice-path load testing** — Twilio Media Streams + STT/TTS under concurrent calls. Establish the per-instance ceiling before customers find it.
- **Monitoring + alerting** — error rates, webhook failures, proposal-execution failures, voice-agent call outcomes. Alert on payment webhook failures, proposal execution failures, voice agent errors.
- **The decisions test stays green** — `decisions.test.ts` enforces the 12 founding decisions; it's part of the bar.
- **A rollback story** — one bad deploy must not strand live phone numbers.

**Fork decision — bar height: full bar before launch.** All five — concurrency-safe executor, critical-path smoke tests, voice load testing, monitoring/alerting, rollback story — are done before the first real customer. A full public launch with live phones and money movement cannot run on thinner observability. Slowest to launch, lowest risk.

**Current state → gap (MODERATE).** *Built:* idempotency on `proposal_executions`, basic execution status guards, the `smoke-test.ts` + Playwright smoke specs, the CI/CD deploy pipeline, `decisions.test.ts`, Sentry integration, and health endpoints. *Weak:* concurrency safety — the executor checks `status === 'executed'` but takes **no DB lock or transaction**, so two workers can both pass the check before either writes (the idempotency key protects the executions table, not the proposal status update). *Missing:* voice-path load testing, configured alerting rules, a metrics dashboard, an end-to-end voice smoke test, and a codified rollback runbook. **The gap is hardening the executor with a lock/transaction + load test + alerting + voice e2e smoke + the runbook — the test and observability scaffolding exists.**

---

## 5. Cross-cutting threads

- **Scheduling ⇄ Communications coupling.** Sections 5 and 7 are designed as one mechanism: every schedule mutation emits an event, and Layer A of communications is nothing but a listener on those events. They must be built and tested together.
- **Everything is a proposal (D-004).** Bookings, customers, estimates, invoices, reschedules, cancellations, marketing messages, expense logs — all flow through the Section 3 approval inbox. The only automatic sends are transactional comms whose underlying action was already approved.
- **The event bus is the backbone.** Sections 5, 6, 7, 8, and 9 all communicate through emitted events (schedule changes, money-state changes, automated-action credits). This is the integration spine.
- **Onboarding is a collection point.** Sections 5 (hours + buffer), 9 (hourly rate), 6/7 (vertical pack templates) all deposit required setup into Section 10. Onboarding must collect everything downstream sections assume.
- **Vertical packs (D-008) seed four things:** job types (§5), flat-rate line items (§6), message templates (§7), triage rules (§1).

---

## 6. Open questions / to resolve during planning

**Resolved — audit-surfaced, decided 2026-05-14 ("keep what's already built"):**
- **§4 lead model** — keep the existing 6-stage pipeline (`new / contacted / qualified / quoted / won / lost`) + kanban `LeadList` UI as-is. No collapse to status-only.
- **§5 single-resource** — keep the multi-technician appointment model as-is; owner-only is enforced by convention (one technician per tenant), not a schema change.

**Carried from the design round:**
- Held-slot expiry window — how long does a tentative hold survive before auto-release if the owner doesn't act? (Interacts with Section 3 push urgency.)
- Time-credit constants for Section 9 — initial values per automated action type; needs a first-pass calibration.
- Trial length confirmed at 14 days — confirm against any existing pricing decision.
- Dormant-customer threshold for re-engagement (assumed ~9 months) — confirm.
- Email fallback provider for Section 7 — audit confirms SendGrid email delivery is already built; confirm it's the intended launch provider.

---

## 7. Section status summary

| # | Section | Fork decision | Gap | Headline gap |
|---|---------|---------------|-----|--------------|
| 1 | Inbound Voice Agent | Held slot + async approval | MODERATE | Held-slot model: schema + `CreateBooking` type + hold lifecycle |
| 2 | In-App Voice Assistant | Push-to-talk now, conversational-ready | SMALL | Launch target already met; polish only |
| 3 | The Approval Inbox | Hybrid push/queue delivery | MODERATE | Unified inbox UI + 2 proposal types + push/queue routing |
| 4 | Customers & Leads | Keep existing 6-stage pipeline + kanban | SMALL | Page already built + wired — remaining: tests + real-tenant-branding endpoint |
| 5 | Jobs & Scheduling | Working hours + gaps availability | MODERATE | Held-slot flag + buffer-aware availability + reschedule/cancel events |
| 6 | Time-to-Cash Chain | Full estimate → invoice chain | MODERATE | Job money-state field + rollup wiring + overdue-detection worker (webhook + reschedule/cancel handlers already built) |
| 7 | Customer Communications | Transactional auto + marketing AI-suggested/approved | MODERATE | Scheduled sends + event→message wirings + STOP compliance |
| 8 | Money Dashboard & Exports | Voice-logged expenses + tax export | **LARGE** | Expense subsystem + dashboard rollup + tax export — all net-new |
| 9 | "Time Given Back" Surface | Time + money equivalent | **LARGE** | Entire surface net-new (event substrate exists) |
| 10 | Onboarding & Self-Serve Setup | Free trial, card required (14-day) | MODERATE | Stitch existing pieces into one resumable flow + trial gate |
| 11 | Launch Quality Bar | Full bar before launch | MODERATE | Harden executor (lock/txn) + load test + alerting + runbook |

**Reading the gap column:** the two **LARGE** items (§8, §9) are net-new feature builds on existing infrastructure. The **MODERATE** items are mostly wiring and lifecycle work on substrate that already exists. The two **SMALL** items (§2, §4) are nearly done — §4's page is already built and wired; only tests + real-tenant-branding remain. Nothing in the eleven is a from-scratch foundation; the ~85%-built estimate holds.

> **Note on gap accuracy:** these gap sizes came from a fast, broad parallel audit. Two corrections above show it can be wrong in either direction: §4's intake page was reported "missing" but is fully built, and §6's Stripe checkout webhook and reschedule/cancel handlers were reported "partial" / "stubs" but are fully wired. Treat each gap size as a starting estimate — the focused codebase explore done at the start of each plan is the authoritative source, and may revise the spec.
