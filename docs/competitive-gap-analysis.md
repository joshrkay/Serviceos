# Competitive Gap Analysis — ServiceOS vs. ServiceTitan-class Platforms

Date: 2026-06-10 (corrected — see note below)
Scope: canonical product (`packages/api`, `packages/web`, `packages/shared`).
North star: **everything in the app can be done by speaking to it — an AI agent
delivers the outcome (scheduling, invoicing, jobs, truck inventory, etc.) with
human approval via the proposal system.**

> **Corrections (2026-06-10):** The first revision of this document wrongly
> listed four built capabilities as gaps. A code-level re-audit found that
> real-time voice (ElevenLabs/Deepgram/Media Streams), drive-time-aware
> scheduling, the in-app voice assistant, and the price book / tiered estimates
> all exist. They are now in §1 (strengths) with their true *residual* gaps.
> Inventory (P14) and equipment (P13) remain absent in code but are already
> specced in `docs/stories/`; the plan now references those specs.

Primary competitive set: ServiceTitan, Housecall Pro, Jobber (field service
management) and Avoca (AI voice front-desk). ServiceNow is enterprise ITSM and
not the real comparison for trades/home-services use cases.

---

## 1. What we already have

Existing comparison/positioning material in the repo:
- `docs/remaining-features.md` — roadmap; names **Avoca** as the primary voice
  competitor and notes our structural advantage over **ServiceTitan**: the
  agent reads our own DB in <50ms instead of going through a third-party API.
- `GO-LIVE-READINESS.md` — production-readiness assessment and blockers.
- `docs/superpowers/agents/` — per-agent specs (invoice, estimate,
  customer-calling, customer-followup).
- `docs/stories/phase-13-gap-stories.md`, `phase-14-gap-stories.md` — schema +
  story specs for equipment and inventory (not yet built).

Verified strengths (code-level audit):

- **Proposal system**: 40 executable AI action types, human-approved, with
  undo window, confidence scoring, idempotency, Zod contracts, full audit.
- **25 AI skills** + intent classification, entity resolution, multi-turn
  orchestration; production LLM gateway (multi-provider failover, caching,
  per-tenant quotas, guardrails).
- **Real-time voice agent on inbound calls**: Twilio inbound webhook → tenant
  lookup → Media Streams WebSocket (`packages/api/src/telephony/media-streams/`)
  with **Deepgram streaming STT** and **ElevenLabs streaming TTS**
  (`packages/api/src/ai/tts/elevenlabs-stream.ts`, `eleven_turbo_v2_5`,
  ~250ms), behind `TWILIO_MEDIA_STREAMS_ENABLED` (Gather fallback otherwise).
  The agent classifies intent, resolves natural-language date/times in tenant
  timezone, checks slot conflicts, and creates `create_appointment` proposals
  whose execution books the appointment and sends confirmation SMS/email.
  *Residual gap:* bookings cannot complete during the call — auto-approval
  requires supervisor presence, so the appointment lands as a proposal for
  async dispatcher approval (see R2 below).
- **Drive-time-aware scheduling**: Google Distance Matrix provider with LRU
  cache and haversine fallback (`packages/api/src/scheduling/travel-time/`),
  appointment feasibility checks that compute drive time between a tech's
  consecutive jobs (`packages/api/src/scheduling/feasibility.ts`), live tech
  GPS pings. No residual gap worth roadmapping now.
- **In-app AI assistant with voice (v1)**: `/api/assistant/chat` with intent
  classification and inline proposals (`packages/api/src/routes/assistant.ts`),
  in-app voice session FSM with SSE (`routes/voice-sessions.ts`),
  `AssistantPage.tsx` with voice-recording overlay and TTS playback, plus the
  technician `VoiceUpdate` flow. *Residual gap:* it is a dedicated page, not a
  global push-to-talk entry in the shell; recording→transcript display is
  unfinished (R3).
- **Price book & tiered estimates**: `PriceBookPage.tsx` (CSV import, edit,
  archive) over `catalog_items.unit_price_cents`; good/better/best estimate
  tiers via line-item groups (migration 127) with customer selection and
  tiered public-quote checkout (`estimates/public-estimate-service.ts`).
  *Residual gap:* markup rules / customer-segment pricing only.
- **Follow-up automation (partial)**: AI-drafted private follow-ups to Google
  reviews (`packages/api/src/reputation/draft-private-followup.ts`); the full
  follow-up agent is specced as P8-015..P8-027 in
  `docs/superpowers/agents/customer-followup/implementation-roadmap.md`.
- Full CRUD + UI for customers, jobs, appointments, estimates, invoices,
  payments (Stripe), leads, service agreements, real-time dispatch board,
  customer portal. Integrations live: Stripe, Twilio (SMS/voice), SendGrid,
  Google Calendar, Clerk, Google Reviews.

---

## 2. Residual gaps in built systems (highest leverage)

These are small, well-scoped pieces of work that complete already-built
pipelines — they unblock the core "speak it and it happens" experience.

| # | Gap | Evidence | Work |
|---|-----|----------|------|
| R1 | **Catalog-priced voice line items.** The invoice-edit task gets no catalog context: `lookup_catalog` returns names only, and `InvoiceEditTaskHandler` (`ai/tasks/invoice-edit-task.ts`) prices line items by LLM guess. "Add a plumbing service call and three gaskets" yields free-text, unpriced lines. | `ai/skills/lookup-catalog.ts`, `ai/tasks/invoice-edit-task.ts` | Inject catalog items + `unit_price_cents` into the edit prompt; resolve spoken items to catalog entries with quantities; price in integer cents. |
| R2 | **Autonomous in-call booking.** `create_appointment` proposals are autonomous-tier but auto-approval requires `supervisorPresent`, which is never true on an inbound call — so no booking confirms during the call (the Avoca parity item). | `proposals/auto-approve.ts`, `ai/tasks/create-appointment-task.ts` | Tenant-configurable autonomous-booking mode: high-confidence, conflict-free appointments execute in-call, relying on undo + audit instead of pre-approval. |
| R3 | **Global push-to-talk.** Assistant voice lives on `AssistantPage` only; techs/dispatchers need a header-level mic on every screen, with finished recording→transcript display. | `components/assistant/AssistantPage.tsx`, shell/layout components | Promote the existing recorder + voice-session FSM into a persistent shell component. |
| R4 | **`issue_invoice` handler missing.** Intent exists in the classifier but no execution handler is registered — it would fail if triggered. Also: customer-call and operator intent taxonomies are separate and don't share invoice intents. | `ai/orchestration/intent-classifier.ts`, `proposals/execution/` | Register the handler; unify the intent taxonomies. |
| R5 | **Invoice delivery hardening.** Delivery defaults to a noop provider in dev; no per-invoice channel choice in the proposal payload. | `proposals/execution/invoice-delivery-factory.ts` | Carry channel in payload; surface preview before send. |

## 3. True feature gaps

### Tier 1 — already specced in repo stories; execute as written

| # | Gap | Spec | Notes |
|---|-----|------|-------|
| G1 | **Truck / material inventory** | **P14-001 / P14-002** (`docs/stories/phase-14-gap-stories.md`): `inventory_items` / `inventory_locations` (warehouse/truck/customer_site) / `inventory_transactions`, `job_parts`, low-stock worker, `lookup_part_availability` voice skill | The "what's in my truck?" use case. Pair with R1 so consumed parts price the invoice. |
| G2 | **Installed equipment / assets** | **P13-002** (`docs/stories/phase-13-gap-stories.md`): `equipment` + `equipment_service_log`, `lookup-equipment` voice skill, CustomerDetail/LocationDetail integration | Enables "what unit does this customer have?" and repair-vs-replace estimates. |
| G3 | **Follow-up agent** | **P8-015..P8-027** (`docs/superpowers/agents/customer-followup/implementation-roadmap.md`): rules, compliance (DNC/consent/quiet-hours), scheduler worker, drafting, reply handling | Review follow-up drafting already shipped; finish the agent. |

### Tier 2 — unspecced parity features

| # | Gap | Status today | Notes |
|---|-----|--------------|-------|
| G4 | **QuickBooks sync** | UI shell only — `QuickBooksModal.tsx` exists in settings but "Connect" is a mocked `setTimeout`; no backend OAuth, no sync | #1 integration ask; bookkeepers veto adoption without it. Backend work via async worker + webhook base patterns. |
| G5 | **Job costing / margin per job** | Foundations exist (time entries, job-scoped expenses, tenant-level money dashboard) but no per-job rollup of labor + materials + expenses → margin | Owners run on this number. Unlocked further by G1 (material costs). |
| G6 | **Purchase orders & vendors** | ABSENT (only a free-text `vendor` field on expenses) | Pairs with G1 for truck restocking. |
| G7 | **Payroll-ready timesheets & commission** | Time tracking exists; no pay rates, commission rules, or payroll export | |
| G8 | **Consumer financing** | ABSENT | Wisetack-style financing on estimates lifts average ticket. |
| G9 | **Custom forms & checklists** | Vertical packs have terminology/templates only; no form builder, tables, or routes | Voice-fillable inspection forms are a differentiator. |
| G10 | **Offline-capable PWA tech app** | ABSENT (no service worker, manifest, or offline queue) | Techs work in basements; voice capture must queue offline. |
| G11 | **Markup / segment pricing rules** | Price book + tiers exist; no markup engine | Small extension of existing catalog. |

### Tier 3 — hardening (precedes go-live regardless)

From `GO-LIVE-READINESS.md`: durable Stripe/Clerk webhook idempotency, RLS
FORCE on 29 tables, payment-mutation audit events, proposal executor
crash-window.

---

## 4. Plan

### Phase 0 — Go-live hardening (1–2 weeks)
Fix the known blockers. No new features ship on an unsafe base.

### Phase 1 — Complete the voice loop (2–3 weeks) — R1–R5
1. Catalog-priced voice invoice line items (R1) — the heart of the
   "service call + three gaskets + sink" scenario.
2. Autonomous in-call booking policy (R2) — Avoca parity.
3. Global push-to-talk shell component (R3).
4. `issue_invoice` handler + intent taxonomy unification (R4); invoice
   delivery hardening (R5).

### Phase 2 — Inventory & assets (3–4 weeks) — G1, G2
Execute P14-001/P14-002 and P13-002 as specced. Add the voice flows on top:
"what's on my truck?", "I used two capacitors", "log the new furnace
model/serial" — wiring `job_parts` consumption into invoice drafting (R1).

### Phase 3 — Money parity (3–4 weeks) — G4, G5, G11
QuickBooks Online sync (real OAuth behind the existing settings modal);
per-job costing rollup (labor × rates + parts + expenses → margin on
`JobDetail` and reports); markup rules on the price book.

### Phase 4 — Follow-up agent (2–3 weeks) — G3
Ship P8-015..P8-027: unsold-estimate chases, maintenance-due reminders from
agreements, review requests — all proposal-gated.

### Phase 5 — Field hardening & expansion (ongoing) — G6–G10
PWA offline queue for voice capture; voice-fillable forms/checklists;
financing partner; POs/vendors; payroll-grade timesheets and commissions.

### Sequencing rationale
Phase 1 is small because the voice infrastructure already exists — the work is
closing the last gaps in already-built pipelines, which compounds: every
feature added afterward (inventory, equipment, costing) is born voice-drivable.
Inventory is second because it is the largest named use-case gap and feeds job
costing in Phase 3.

---

## 5. Positioning summary

| | ServiceTitan | Avoca | **ServiceOS target** |
|---|---|---|---|
| Breadth (FSM features) | Deep, complex, expensive | Thin (front-desk only) | Mid-depth, SMB-priced |
| AI voice agent | Bolt-on | Core, but read-mostly over others' data | Core, **writes** via proposals over its own DB (<50ms reads) |
| Safety model | n/a | Limited | Human-approved proposals + undo + audit (moat) |
| Real-time voice | Partial | Yes (<800ms) | **Built** (Deepgram + ElevenLabs + Media Streams); in-call booking pending (R2) |
| Drive-time scheduling | Yes | No | **Built** |
| Inventory | Yes | No | Specced (P14) — Phase 2 |

The wedge: ServiceTitan has the features but the AI is bolted on; Avoca has
the voice but can't run the business. ServiceOS is the only one where speaking
to the app *is* the app, with an auditable approval layer that owners trust.
