# Competitive Gap Analysis — ServiceOS for the 1–5 Person Shop

Date: 2026-06-10 (rev 3 — ICP reframe; corrections note below)
Scope: canonical product (`packages/api`, `packages/web`, `packages/shared`).

## The pitch

**"You know the trade. We run the business."**

Target customer: the plumber/HVAC tech/electrician working for a 500-person
company who wants to go independent — and the 1–5 person shops they become.
They are masters of the field work and allergic to the office work. ServiceOS
is the AI back office: the phone gets answered and appointments get booked
while they're under a sink; invoices get drafted, priced, and sent by telling
the app what happened; estimates get chased; the books stay clean for the
accountant. Everything is voice-first, because their hands are busy.

North star: **everything in the app can be done by speaking to it — an AI
agent delivers the outcome, with approval/undo/audit as the trust layer.**

> **Corrections (2026-06-10):** Rev 1 wrongly listed four built capabilities
> as gaps. A code-level re-audit found real-time voice (ElevenLabs/Deepgram/
> Media Streams), drive-time-aware scheduling, the in-app voice assistant, and
> the price book / tiered estimates all exist (§2). Inventory (P14) and
> equipment (P13) are absent in code but specced in `docs/stories/`.

## Competitive set, reframed for this ICP

- **Jobber / Housecall Pro** — the real head-to-head. Priced for small shops,
  but AI is a bolt-on assistant; the owner still does the office work, just in
  a nicer UI. Our wedge: they give you better paperwork; we do the paperwork.
- **ServiceTitan** — not a competitor at this ICP (enterprise pricing,
  onboarding measured in months). It is the *graduation risk*: shops that grow
  past ~10 techs leave for it. We win by being what they start on and making
  leaving unnecessary for as long as possible — not by matching its feature
  sheet (payroll, POs, multi-warehouse) that a 2-person shop never touches.
- **Avoca / AI front-desk tools** — answer the phone but can't run the
  business: no invoices, no money, read-mostly over someone else's system of
  record. We own the system of record, so the voice agent can *write*.
- **ServiceNow** — enterprise ITSM; not the comparison for this market.

What this ICP actually buys on (in order): (1) never miss a call/job,
(2) get paid faster with less typing, (3) look professional to customers,
(4) keep the accountant happy. They do not buy on dispatch boards, payroll
modules, or purchase orders.

---

## 1. What we already have (verified in code)

- **Real-time AI phone agent**: Twilio inbound → Media Streams WebSocket
  (`packages/api/src/telephony/media-streams/`) with Deepgram streaming STT
  and ElevenLabs streaming TTS (`ai/tts/elevenlabs-stream.ts`, ~250ms),
  behind `TWILIO_MEDIA_STREAMS_ENABLED`. Classifies intent, resolves
  natural-language times in tenant timezone, checks slot conflicts, creates
  `create_appointment` proposals; execution books + sends confirmation
  SMS/email. *Residual gap:* can't complete the booking during the call (R1).
- **Proposal safety layer**: 40 AI action types, approval + 5s undo +
  confidence + idempotency + audit. This is the trust story for a solo owner
  handing their business to an AI.
- **In-app AI assistant with voice (v1)**: `/api/assistant/chat` with intent
  classification + inline proposals (`routes/assistant.ts`), voice session FSM
  (`routes/voice-sessions.ts`), `AssistantPage.tsx` with recording + TTS.
- **Drive-time-aware scheduling**: Google Distance Matrix with cache +
  haversine fallback (`scheduling/travel-time/`), feasibility checks between
  consecutive jobs, live tech GPS. Done.
- **Price book & tiered estimates**: `PriceBookPage.tsx` (CSV import),
  `catalog_items.unit_price_cents`, good/better/best line-item groups
  (migration 127) with customer selection + tiered public checkout.
- **Money rails**: estimates → invoices → Stripe payment links, public pay
  pages, recurring/batch invoices, dunning (partial), tax export
  (`reports/tax-export.ts`), money dashboard.
- **Review follow-up drafting** (`reputation/draft-private-followup.ts`);
  full follow-up agent specced (P8-015..027).
- Full CRUD + UI: customers, jobs, appointments, estimates, invoices,
  payments, leads, agreements, dispatch board, customer portal, technician
  mobile views. Integrations: Stripe, Twilio, SendGrid, Google Calendar,
  Clerk, Google Reviews. Onboarding v2 in progress.

---

## 2. Gaps, ranked for the 1–5 person shop

### Tier 1 — the promise breakers (the pitch is false until these ship)

| # | Gap | Why it's tier 1 at this ICP | Evidence / spec |
|---|-----|------------------------------|-----------------|
| R1 | **Autonomous in-call booking.** Auto-approval requires `supervisorPresent` — a dispatcher that **does not exist** in a 1–5 person shop. Today every AI "booking" waits for a human tap, which means the owner under a sink IS the dispatcher. The supervisor-presence model is an enterprise assumption baked into an SMB product. | "Never miss a job" is buy-reason #1. The caller must hang up with a confirmed slot. | `proposals/auto-approve.ts`, `ai/tasks/create-appointment-task.ts`. Make autonomous booking the default for high-confidence, conflict-free slots; undo + audit + SMS confirm is the safety net. |
| R2 | **Catalog-priced voice invoicing.** `lookup_catalog` returns names only; `InvoiceEditTaskHandler` gets no catalog context, so "add a service call and three gaskets" yields unpriced free-text lines the owner must fix by hand — the exact office work we promised to remove. | "Get paid without typing" is buy-reason #2. | `ai/skills/lookup-catalog.ts`, `ai/tasks/invoice-edit-task.ts`. Inject catalog + prices into the edit prompt; resolve items→SKU+qty in integer cents. Also wire the missing `issue_invoice` handler. |
| R3 | **Voice everywhere on mobile.** The assistant lives on a desktop page; the ICP lives in a truck. Needs a persistent push-to-talk mic in the shell, mobile-first, with finished recording→transcript display. | The owner's computer is their phone. | Promote `AssistantPage` recorder + voice-session FSM into the shell/layout. |
| R4 | **Offline/PWA voice capture.** No service worker, manifest, or offline queue. Basements and crawlspaces are where the work happens; a voice note that drops with signal is a lost invoice line. | Field reality for trades. | `packages/web`: PWA manifest + queued voice capture, sync on reconnect. |

### Tier 2 — back-office completeness (the "we run the business" half)

| # | Gap | ICP angle | Evidence / spec |
|---|-----|-----------|-----------------|
| G1 | **Follow-up agent** (unsold-estimate chases, maintenance reminders, review asks) | A solo owner never follows up; this is found money with zero effort. Drafting layer already shipped. | Execute **P8-015..P8-027** (`docs/superpowers/agents/customer-followup/`). |
| G2 | **QuickBooks Online sync** | Buy-reason #4: the accountant demands it. UI shell already exists (`settings/QuickBooksModal.tsx`) but "Connect" is a mocked `setTimeout` — no OAuth or sync behind it. | Real OAuth + invoice/payment/customer sync via async worker + webhook base. |
| G3 | **Truck inventory** | At this ICP the truck IS the warehouse. "What's on my truck?" / "I used two capacitors" — and consumed parts should price the invoice (feeds R2). | Execute **P14-001/P14-002** (`docs/stories/phase-14-gap-stories.md`) — keep it simple: one truck per tech, no multi-warehouse. |
| G4 | **Installed equipment records** | "The Smiths' furnace, installed 2019" → repair-vs-replace estimates and agreement upsells; the voice agent can answer customer history questions. | Execute **P13-002** (`docs/stories/phase-13-gap-stories.md`). |
| G5 | **Per-job profit by voice** | Foundations exist (time entries, job expenses, money dashboard) but no per-job rollup. The ICP question is "did I make money on that job?" — answerable by voice, not a BI screen. | Rollup of labor + parts + expenses → margin on `JobDetail` + a `lookup_job_profit` skill. |
| G6 | **Receipt → expense by photo/voice** | They buy parts at the supply house counter; snap the receipt or say "spent $84 at Ferguson on the Miller job." Expense capture exists; the camera/voice path doesn't. | Extend `log_expense` proposal with photo OCR; reuse job-photo S3 path. |

### Tier 3 — de-prioritized for this ICP (revisit as customers grow)

- **Payroll & commission** — most of the market has 0–4 employees; timesheet
  export is enough for now.
- **Purchase orders / vendors** — supply-house counter purchases, not POs.
  G6 (receipt capture) is the right-sized version.
- **Custom forms builder** — ship a few canned per-vertical checklists
  (voice-fillable) instead of a builder.
- **Consumer financing** — valuable for ticket size, but integration-heavy;
  after Tier 2.
- **Markup/segment pricing rules** — price book + tiers cover the ICP today.
- **Deeper dispatch/capacity tooling** — the existing board already exceeds
  what a 3-truck shop needs.

### Tier 4 — hardening (precedes go-live regardless)

From `GO-LIVE-READINESS.md`: durable Stripe/Clerk webhook idempotency, RLS
FORCE on 29 tables, payment-mutation audit events, executor crash-window.

---

## 3. Plan

### Phase 0 — Go-live hardening (1–2 weeks)
Tier 4 blockers. No features on an unsafe base.

### Phase 1 — Make the pitch true (2–3 weeks) — R1–R4
1. Autonomous in-call booking (R1) — the flagship demo: call the number, get
   booked, owner gets a text, never touched the phone.
2. Catalog-priced voice invoicing + `issue_invoice` handler (R2).
3. Push-to-talk in the mobile shell (R3).
4. PWA + offline voice queue (R4).

### Phase 2 — Found money (2–3 weeks) — G1, G2
Follow-up agent (P8 stories) and real QuickBooks sync. Both are retention
anchors: one makes them money while they sleep, the other makes leaving
painful for the accountant.

### Phase 3 — The truck and the job (3–4 weeks) — G3, G4, G5, G6
Truck inventory (P14) + equipment records (P13), per-job profit by voice,
receipt capture. Parts consumption flows straight into invoice lines (R2).

### Phase 4 — Grow-with-you (ongoing) — Tier 3 items as customers scale
Canned voice checklists, financing, payroll export, pricing rules.

### Sequencing rationale
Phase 1 is the pitch itself — every item removes a moment where the owner has
to stop being a plumber and become a dispatcher or bookkeeper. Phase 2 is
revenue the owner can feel without doing anything. Phase 3 deepens the moat
around the field workflow. Tier 3 features wait until our customers grow into
them — which is also our ServiceTitan-graduation defense.

---

## 4. Positioning summary

| | Jobber / HCP | ServiceTitan | Avoca | **ServiceOS** |
|---|---|---|---|---|
| Target | 1–50 techs | 10–1000 techs | Front desk add-on | **1–5 techs going independent** |
| AI role | Assistant features | Bolt-on | Answers phone, read-mostly | **Runs the back office, writes via proposals over own DB** |
| Owner's office workload | Reduced | Shifted to office staff | Calls only | **Eliminated by voice** |
| Safety/trust | n/a | n/a | Limited | Approval + undo + audit |
| Real-time voice | No | Partial | Yes | **Built**; in-call booking = R1 |
| Price for a 2-person shop | OK | Prohibitive | Add-on cost | Core design constraint |

The wedge in one line: Jobber gives the new business owner better paperwork;
ServiceTitan gives them an office they can't afford; Avoca answers their
phone. ServiceOS does the office work — they speak, it happens, and they get
to stay a tradesperson.

---

## 5. Post-plan head-to-head: ServiceOS vs Jobber

Assumes all lanes in `docs/launch-plan.md` ship (P12, P18, P22, P14, P13,
P15-001, P8, P20). Jobber is the primary head-to-head at this ICP.

### Where ServiceOS leads

- **The AI runs the business; Jobber's AI assists with it.** Jobber's AI
  Receptionist answers calls and captures requests but hands off to the
  office workflow — a human still quotes, schedules, invoices. Post-plan,
  our agent *completes* the work: books during the call (P12-004
  unsupervised routing), drafts and issues a catalog-priced invoice from a
  spoken sentence (P22-001/002), chases unsold estimates autonomously (P8),
  answers "did I make money on that job?" by voice (P22-005). Jobber has no
  equivalent of the proposal/undo/audit layer — that is the trust story for
  handing an AI the keys.
- **Voice as the primary interface.** Jobber Copilot is a chat assistant
  inside the app; push-to-talk everywhere + offline voice queue
  (P22-003/004) makes speaking the default way to operate.
- **Truck inventory.** Jobber has no inventory — a known top complaint that
  pushes growing shops to Housecall Pro or ServiceTitan. P14
  (truck-as-warehouse, parts auto-deduct into invoice lines) plus
  "what's on my truck?" is a differentiator, not parity.
- **Per-job profitability.** Jobber gates job costing to its top plan; we
  ship it answerable by voice.

### Where we reach parity

- **QuickBooks sync** (P15-001) — functional parity for a 1–5 person shop
  (paid invoices → sales receipts); Jobber's sync is deeper and
  battle-tested.
- **The money loop** — tiered quotes, payment links, auto-invoice, dunning
  (P20), customer portal, online booking, review requests, referrals
  (P15-005).
- **Scheduling** — drive-time feasibility (already built) is comparable to
  or edges Jobber's route optimization.

### Where Jobber still wins

1. **Native mobile apps.** Polished iOS/Android vs our PWA — the biggest
   remaining experience gap (app-store presence, push notifications, camera
   integration).
2. **Maturity and trust.** ~250K+ service pros, years of edge cases,
   ecosystem integrations (Zapier, Mailchimp, ...), brand recognition. We
   have ~6 integrations and a v1 of everything.
3. **Consumer financing** — Wisetack is built into Jobber; still Tier 3 for
   us, and it materially lifts average ticket.
4. **Custom job forms** — Jobber has a form builder; we ship canned vertical
   checklists at best.
5. **Marketing suite breadth** — Jobber's campaigns/email marketing is
   broader; our follow-up agent is more autonomous within a narrower scope.

### Net

Post-plan, the comparison stops being feature-vs-feature and becomes
workload-vs-workload: Jobber gives the owner a well-organized office job to
do at night; ServiceOS does the office job. The demo writes itself — owner
under a sink, phone rings, appointment books itself, invoice issues itself
from a spoken sentence, QuickBooks stays current. Jobber cannot bolt this on
easily: its AI sits on top of the system, ours *is* the system of record
with write access via proposals.

Two vulnerabilities to manage: the native-app gap (the PWA buys time, not
parity) and the trust deficit of being new — which is why approval + undo +
audit belongs front-and-center in marketing, not buried in docs.

---

## 6. Shipped since this analysis (Jobber-parity pass, 2026-06-28)

Closing named Jobber gaps. Each landed full-stack with unit + Docker-gated
integration tests and a production `tsc` build gate.

- **Job Forms & Checklists** (was Tier 3 "custom forms builder", de-prioritized
  in §2 — now built, not just canned checklists). Tenant-defined form/checklist
  templates + per-job submissions that snapshot the template so a completed
  record is immutable history. Backend: `packages/api/src/job-forms/`,
  migration 221, `/api/job-forms`. Web: template builder in Settings →
  AI & Automation → "Forms & checklists" (`JobFormTemplatesSheet`) + a
  fill/complete panel on the job detail (`JobFormsPanel`).
- **Installable PWA + offline app shell** (R4 — the native-mobile gap in §5
  "Where Jobber still wins"). `packages/web/public/manifest.webmanifest` +
  `sw.js` (network-first navigations → offline fallback; `/api` always
  bypasses cache) + `src/pwa/register-sw.ts`. Buys time on native, not parity.
- **Recurring jobs** (Jobber flagship for maintenance/cleaning/lawn shops;
  previously only a `maintenance_contracts` record with a free-text cadence).
  Pure recurrence engine (daily/weekly/biweekly/monthly, interval, count/until,
  month-end clamping) + series CRUD + computed visit-date preview. Backend:
  `packages/api/src/recurring-jobs/`, migration 222, `/api/recurring-jobs`.
  Web: `RecurringJobsPanel` on the customer detail.
- **Recurring-job materialization** (completes the above to full parity).
  Series now carry per-visit scheduling intent (time-of-day, duration, visit
  kind). `materializeRecurringJob` (`recurring-jobs/materialize.ts`) generates
  a real Job + Appointment for each due occurrence in a horizon, placing the
  time-of-day in the tenant timezone (luxon, DST-correct) at the customer's
  primary service location. Idempotent via a `recurring_job_occurrences` ledger
  (UNIQUE per series+date, claim-before-create), migration 223,
  `POST /api/recurring-jobs/:id/generate` + a "Schedule visits" action on the
  panel. **Follow-up:** a scheduled worker to auto-run generation, and surface
  the upcoming series on the dispatch calendar.
- **Job custom fields** (multi-entity custom fields — Jobber supports custom
  fields on jobs/quotes/clients; we had clients only). Tenant-defined,
  structured/reportable fields on the job record (PO #, permit #, gate code),
  distinct from Job Forms (fillable per-visit checklists). Backend reuses the
  generic field-type validators (`jobs/job-custom-field.ts`), migration 224,
  `/api/job-custom-fields`. Web: values panel on the job detail +
  definition manager in Settings → AI & Automation → "Job custom fields".
