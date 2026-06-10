# Competitive Gap Analysis — ServiceOS vs. ServiceTitan-class Platforms

Date: 2026-06-10
Scope: canonical product (`packages/api`, `packages/web`, `packages/shared`).
North star: **everything in the app can be done by speaking to it — an AI agent
delivers the outcome (scheduling, invoicing, jobs, truck inventory, etc.) with
human approval via the proposal system.**

Primary competitive set: ServiceTitan, Housecall Pro, Jobber (field service
management) and Avoca (AI voice front-desk). ServiceNow is enterprise ITSM and
not the real comparison for trades/home-services use cases; the analysis below
targets the field-service market ServiceOS actually serves.

---

## 1. What we already have (and where it's documented)

Existing comparison/positioning material in the repo:
- `docs/remaining-features.md` — roadmap; names **Avoca** as the primary voice
  competitor ("answers instantly", <800ms time-to-first-audio) and notes our
  structural advantage over **ServiceTitan**: the agent reads our own DB in
  <50ms instead of going through a third-party API.
- `GO-LIVE-READINESS.md` — production-readiness assessment and blockers.
- `docs/superpowers/agents/` — per-agent specs (invoice, estimate,
  customer-calling, customer-followup).

Current strengths (genuinely differentiated):
- **Proposal system**: 40 executable AI action types, all human-approved, with
  undo window, confidence scoring, idempotency, Zod contracts, full audit.
- **25 AI skills** (lookups + operations) with intent classification, entity
  resolution, multi-turn orchestration.
- **Production LLM gateway**: multi-provider failover, circuit breaker,
  caching, per-tenant quotas, guardrails.
- Full CRUD + UI for customers, jobs, appointments, estimates, invoices,
  payments (Stripe), leads, service agreements, dispatch board (real-time),
  customer portal, technician mobile views, voice notes (`VoiceUpdatePage`).
- Integrations live: Stripe, Twilio (SMS/voice), SendGrid, Google Calendar,
  Clerk, Google Reviews.

---

## 2. Gap list

Ranked by impact on the voice-first vision and competitive parity.

### Tier 1 — Core gaps that block the vision

| # | Gap | Status today | Why it matters |
|---|-----|--------------|----------------|
| G1 | **Truck / material inventory** | NOT BUILT (catalog exists, but no stock, no per-truck locations, no consumption) | Explicit use case: "what's in my truck?" Requires inventory locations (warehouse, truck), stock levels, transfers, and consumption on job completion. ServiceTitan's inventory module is a major upsell. |
| G2 | **Real-time voice loop (<800ms TTFA)** | Partial — Whisper file-based STT; Deepgram/ElevenLabs streaming planned (P8-012); customer-calling state machine built but Media Streams pending | Without streaming STT/TTS the "speak it and it happens" experience feels like voicemail, not an assistant. This is the Avoca parity item. |
| G3 | **Universal in-app voice assistant** | Voice input exists only for technician job updates (`VoiceUpdate.tsx`) | The vision is *every* surface voice-drivable: dispatcher, owner, tech. Needs a global push-to-talk entry point wired to the existing intent classifier → proposal pipeline, on every page. |
| G4 | **Voice → proposal coverage for all 40 proposal types** | Intent classifier covers ~14–15 intents | Inventory, agreements, time entries, expenses, batch invoicing etc. need spoken-intent routes so anything doable in the UI is doable by voice. |
| G5 | **Installed equipment / asset records** | NOT BUILT | "The Smiths' furnace, installed 2019, model X" — table-stakes for HVAC/plumbing. Drives agreements, repair-vs-replace estimates, and lets the voice agent answer "what unit does this customer have?" |

### Tier 2 — Feature parity with ServiceTitan/Jobber/HCP

| # | Gap | Status today | Notes |
|---|-----|--------------|-------|
| G6 | **Flat-rate price book** | Catalog is partial; no flat-rate book, no good/better/best presentation | Core to trades sales workflow; also gives the estimate agent reliable pricing ground truth. |
| G7 | **Purchase orders & vendors** | NOT BUILT | Pairs with G1 — restocking trucks, job-costed POs. |
| G8 | **QuickBooks (accounting) sync** | NOT BUILT (noted as future) | #1 integration ask in this market; without it bookkeepers veto adoption. |
| G9 | **Route optimization / smart capacity scheduling** | Dispatch board + availability lookup exist; no drive-time-aware slot ranking | "Book the Smiths Tuesday" should pick the slot that minimizes drive time. Weather cache already exists as a context input. |
| G10 | **Job costing / gross-margin per job** | Expenses + time entries are partial; no rolled-up margin view | Owners run their business on this number. |
| G11 | **Payroll-ready timesheets & commission** | Time tracking partial | Export-grade timesheets, commission rules on sold estimates. |
| G12 | **Marketing & campaigns** (review requests exist) | Feedback/reviews partial; no campaigns, no unsold-estimate follow-up automation | The customer-followup agent spec (`docs/superpowers/agents/customer-followup/`) covers part of this — finish it. |
| G13 | **Consumer financing** | NOT BUILT | Wisetack-style financing on estimates lifts average ticket; ServiceTitan/HCP both have it. |
| G14 | **Forms & checklists** (safety, inspection) | NOT BUILT | Voice-fillable checklists are a strong differentiator ("AI fills the inspection form from the tech's narration"). |
| G15 | **Offline-capable native/PWA tech app** | Responsive web views only | Techs work in basements and dead zones; voice capture must queue offline and sync. |

### Tier 3 — Hardening (blockers already known)

From `GO-LIVE-READINESS.md`: durable Stripe/Clerk webhook idempotency, RLS
FORCE on 29 tables, payment-mutation audit events, proposal executor
crash-window. These precede any go-live regardless of feature work.

---

## 3. Plan

### Phase 0 — Go-live hardening (1–2 weeks)
Fix the known blockers (webhook idempotency, RLS FORCE, payment audit,
executor crash-window). No new features ship on an unsafe base.

### Phase 1 — Voice everywhere (3–4 weeks) — G2, G3, G4
1. Land streaming STT (Deepgram Nova-3) + streaming TTS (ElevenLabs) behind the
   LLM gateway; finish Twilio Media Streams (P8-012) for telephony.
2. Global push-to-talk assistant component in `packages/web` (header-level,
   all roles), streaming transcript → existing intent classifier →
   proposal inbox. Reuse `VoiceUpdate` plumbing.
3. Expand intent classifier + task router to cover all 40 proposal types;
   add eval cases per intent (existing evaluation-snapshot infra).

### Phase 2 — Inventory & assets (3–4 weeks) — G1, G5
1. Schema: `inventory_locations` (warehouse/truck), `stock_levels`,
   `stock_movements` (transfer/consume/receive/adjust), `equipment` (installed
   assets per service location). Tenant RLS + audit, integer cents for costs.
2. Consumption hooks: completing a job with material line items decrements the
   assigned tech's truck stock (proposal-gated).
3. New AI skills: `lookup_truck_inventory`, `lookup_equipment`; new proposals:
   `adjust_inventory`, `transfer_stock`, `record_equipment`.
4. Voice flows: "what's on my truck?", "I used two capacitors on this job",
   "log the new furnace model/serial".

### Phase 3 — Money parity (3–4 weeks) — G6, G8, G10
1. Flat-rate price book on top of catalog (markup rules, good/better/best
   estimate options in the portal).
2. QuickBooks Online sync (invoices, payments, customers) via the async worker
   + webhook base patterns.
3. Job costing rollup: labor (time entries × rates) + materials (stock
   consumption × cost) + expenses → margin on `JobDetail` and reports.

### Phase 4 — Smart scheduling & follow-up (2–3 weeks) — G9, G12
1. Drive-time-aware slot ranking in `lookup_availability` (Google routes API),
   feeding both the voice agent and the portal slot picker.
2. Ship the customer-followup agent: unsold-estimate chases, maintenance-due
   reminders from agreements, review requests — all proposal-gated.

### Phase 5 — Field hardening & expansion (ongoing) — G11, G13, G14, G15
PWA offline queue for voice capture; voice-fillable forms/checklists;
financing partner integration; payroll-grade timesheets and commissions.

### Sequencing rationale
Voice-everywhere comes first because it compounds: every feature added
afterward (inventory, price book, scheduling) is born voice-drivable instead
of retrofitted. Inventory is second because it is the largest named use-case
gap and unlocks job costing in Phase 3.

---

## 4. Positioning summary

| | ServiceTitan | Avoca | **ServiceOS target** |
|---|---|---|---|
| Breadth (FSM features) | Deep, complex, expensive | Thin (front-desk only) | Mid-depth, SMB-priced |
| AI voice agent | Bolt-on | Core, but read-mostly over others' data | Core, **writes** via proposals over its own DB (<50ms reads) |
| Safety model | n/a | Limited | Human-approved proposals + undo + audit (moat) |
| Inventory | Yes | No | **Gap — Phase 2** |
| Real-time voice | Partial | Yes (<800ms) | **Gap — Phase 1** |

The wedge: ServiceTitan has the features but the AI is bolted on; Avoca has
the voice but can't run the business. ServiceOS is the only one where speaking
to the app *is* the app, with an auditable approval layer that owners trust.
