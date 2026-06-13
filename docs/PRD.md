# AI Service OS — Product Requirements Document

> **⚠️ Subordinate for LAUNCH (2026-06-13).** For the launch thesis, scope,
> positioning, and sequencing, the authoritative document is now
> **`docs/PRD-launch-v1.md`** ("run-by-text + collect"). This v2.0 PRD remains
> the **broader product/domain requirements reference** — personas, entity
> model, the full feature surface — but it is **subordinate to the launch PRD
> for any launch decision**. The authoritative record of what is **completed &
> bug-free** (vs. partial / buggy / stub / dead) is
> **`docs/feature-status-ledger.md`** (file:line-cited at HEAD, build gate
> PASS). Where this doc and either of those disagree, **they win**. The "v2.0
> supersedes v1 / canonical" line below is softened accordingly: it supersedes
> the *old story-level v1 execution catalog*, **not** the launch PRD.

**Version**: 2.0
**Status**: Broad product/domain requirements reference. Supersedes the prior
v1 *execution catalog* (`docs/PRD-execution-catalog.md`) for product strategy,
but is **subordinate to `docs/PRD-launch-v1.md` for launch thesis, scope,
positioning, and sequencing**, and to `docs/feature-status-ledger.md` for
the verified completed/bug-free feature record.
**Last revised**: 2026-05-17 · **Subordinated to launch PRD**: 2026-06-13
**Owner**: Product

---

## About this document

This PRD is the single source of truth for **what we're building, who it's
for, and why.** It is the product-level reference for every team:
engineering, design, sales, support, and leadership.

**Companion documents** (treat as authoritative for their domain):
- `docs/strategy/day-in-the-life.md` — the emotional and operational spine;
  the personas; the bad-day failure modes.
- `docs/strategy/roadmap-audit.md` — how the current build maps against
  this PRD, with cut / defer / pull-forward recommendations.
- `docs/PRD-execution-catalog.md` — the engineering execution catalog (was
  v1 of this PRD). Per-story build prompts, review prompts, acceptance
  criteria, and dependencies. **Still the source of truth for story-level
  detail on stories not amended in this v2.**
- `CLAUDE.md` — the persistent agent context (locked patterns, allowed
  files, build verification rules).

**When this doc and the v1 *execution catalog* disagree, this doc wins.**
Stories from that catalog not contradicted here are still in effect; stories
explicitly amended or replaced here override it. **(corrected 2026-06-13: this
precedence is scoped to the old execution catalog only. For the LAUNCH thesis,
scope, positioning, and sequencing, `docs/PRD-launch-v1.md` governs and this
doc is subordinate; for the verified completed/bug-free feature record,
`docs/feature-status-ledger.md` governs.)**

**Versioning rule**: This PRD is bumped (1.0 → 2.0 → 3.0) when product
strategy changes. It is the artifact that boards, designers, and new hires
read first.

---

## 1. Executive summary

### The pitch (one sentence)

> **You learned the trade. We'll run the business.**
> AI answers your phone, books your jobs, sends your estimates, and chases
> your invoices. You approve what matters in 30 seconds a day.
> Built for the shop with 2 trucks and no office.

### What it is

A voice-and-SMS-first **AI back office** for small home-service businesses
(HVAC and plumbing in V1). The owner does not run a dashboard. The owner
runs their trade. The AI runs the business side: phone answering, intake,
scheduling, estimating, invoicing, payment chasing, review monitoring, and
end-of-day reporting — and surfaces only the decisions that require a human.

### What it is not

- Not a CRM the owner logs into every morning.
- Not a dispatch console for a 10-person ops team.
- Not a customer-facing self-service portal.
- Not a marketing automation platform.
- Not a tax/payroll/legal tool.

(See §7 for the full in-scope / out-of-scope list.)

### Headline metric

**Owner hours returned per week.** This is the north star. The unit of
value we sell. Every feature is judged by whether it adds or subtracts
from this number.

Secondary headline: **time-to-cash** (days between job completion and
payment received), because it's the financial proxy the customer feels.

### Why now

Three things only became true in the last 18 months:
1. Real-time voice models can hold a competent service-business
   conversation under $1/min in COGS.
2. SMS + payment links + Stripe/Twilio APIs are mature enough that an AI
   can run an entire money flow.
3. The owner-operator labor crisis (no admin staff available, no time to
   train one) is forcing demand. Ten years ago the answer was "hire a
   receptionist." Today nobody can.

---

## 2. Customers and personas

### ICP definition

Primary ICP: **owner-operator home-service shops with 1–3 trucks, no
dedicated office staff, revenue $200K–$1M, in HVAC or plumbing.**

Disqualifying signals:
- 5+ employees with a dedicated office manager
- Already on ServiceTitan and happy
- Want to grow into a 20-truck fleet (we serve owner-operators by
  preference, not aspirationally)
- Don't carry a smartphone

### Primary persona — Mike Rivera (HVAC, 2 trucks)

Phoenix HVAC owner. 38. Married, two young kids. Wife works full-time as
a nurse. One employee (Carlos, cousin, technician). Revenue $680K. His
real job title is *dispatcher, CSR, estimator, bookkeeper, collections
agent, marketing manager, and HVAC technician* — only the last is the one
he wanted.

**Full narrative**: `docs/strategy/day-in-the-life.md` §"Persona 1 —
Mike."

### Secondary persona — Jenna Walsh (plumbing, solo)

Cleveland solo plumber. 41. Divorced, raising a 14-year-old son. 18
years in the trade, 3 years on her own. Revenue $340K. Doesn't want to
grow into a fleet — wants to stay solo and reclaim her life. Her admin
load is single-threaded (one phone, one person), which makes the AI back
office *more* urgent, not less.

**Full narrative**: `docs/strategy/day-in-the-life.md` §"Persona 2 —
Jenna."

### Anti-personas (do not optimize for)

- **The dispatcher at a 12-truck shop.** Different product. Buys
  ServiceTitan.
- **The franchise owner.** Wants brand compliance tooling, not a back
  office.
- **The hobbyist / side-hustle plumber.** Doesn't have the revenue to
  justify $300–$500/mo.

### The 3rd persona we will ship for (Wave 3+)

**The owner-operator's spouse, doing the books at the kitchen table on
Saturday morning.** Often the unseen second user. The end-of-day digest
and weekly summary must work for them.

---

## 3. Locked product decisions

These are the 14 commitments that drive every feature and design
decision. They are repeated here from `day-in-the-life.md` so this PRD
is self-contained.

| # | Decision | Implication |
|---|----------|-------------|
| 1 | SMS is the primary interface | Every proposal is dispatchable as SMS with Approve/Edit/Reject affordances. The web app exists for audit and configuration; no daily action requires opening it. |
| 2 | End-of-day digest is the dashboard | A 6–9pm SMS summary, with a *"what I wasn't sure about today"* section. No real-time charts. |
| 3 | One-tap approvals with dictation edits | Every proposal SMS supports Approve / Edit / Reject. Edits accept voice dictation. No forms. |
| 4 | Confidence is surfaced, not hidden | Where the system is unsure (parts, prices, urgency, model numbers), the doubt is visible to the owner. Not a percentage on every line — surfaced only where it matters. |
| 5 | Supervisor-agent review of every booking and quote | A cheaper classifier reviews the primary system's outputs for missed urgency, pricing anomalies, and out-of-pattern decisions. |
| 6 | Emergency intent overrides automation | Urgency + vulnerability signals (medical, age, weather, water-damage-in-progress) route to the owner's phone immediately. Voice triage, not booking. |
| 7 | AI never discounts or commits to scope changes | Pricing pushback, scope expansion, "let me talk to the owner" requests all route through the owner with a recommendation. |
| 8 | Dropped calls trigger automatic SMS recovery | Voice → text fallback within 60 seconds, with partial transcript context. |
| 9 | B2B account recognition is first-class | Property managers, real-estate agents, and repeat commercial accounts route differently from one-off residential calls. |
| 10 | Vertical packs matter | Plumbing: MMS-to-quote and severity triage. HVAC: equipment history and seasonal load awareness. Architecture supports both without forks. |
| 11 | Google review monitoring with draft-response approval | Shipped from day one. Reputation recovery is part of the back office. |
| 12 | Brand voice is configurable, then locked | Every AI utterance — calls, texts, invoices, follow-ups, review responses — sounds like the shop. |
| 13 | Every AI mistake is a learning event | The owner's correction updates the system. The digest reports back what the system has learned. |
| 14 | No feature ships that adds admin work to the owner's day | The litmus test. |

---

## 4. Trust and failure-mode architecture

### The trust thesis

No AI system is right 100% of the time. **The trust mechanism is not
perfection — it's how the system behaves when it's wrong.** ServiceTitan,
HCP, Rosie, Goodcall, and the other AI receptionists paper over their
failures. Our wedge is being the system that **tells the truth about
itself**.

### The four trust pillars

1. **The AI surfaces its own uncertainty.** When the system is <80%
   confident on a part, price, or urgency call, the doubt is visible
   to the owner before the message goes out.
2. **A supervisor agent reviews high-stakes outputs.** A cheaper, separate
   classifier reviews every booking and quote post-hoc for missed
   urgency, pricing anomalies, and out-of-pattern decisions. It flags
   within 60 seconds.
3. **The AI never makes irreversible-for-the-business decisions
   unilaterally.** Discounts, scope changes, commitments of a human, and
   refunds always route through the owner.
4. **The end-of-day digest tells the truth.** A "what I wasn't sure about
   today" section appears every evening. Receptionists like Rosie/Goodcall
   never tell you what they got wrong.

### The seven failure modes the product is designed to handle

Catalogued in detail in `docs/strategy/day-in-the-life.md` §"When
Serviceos fails — Mike's bad Tuesday":

1. **Wrong quote** (stale labor rate) → caught in approval queue with a
   correction prompt; rate updates forward.
2. **Hallucinated part** → low-confidence badge + escalate-to-Carlos
   flow.
3. **Missed emergency intent** → supervisor agent flags within minutes.
4. **Dropped call** → automatic SMS recovery in 60 seconds.
5. **Customer game-plays the price** → AI refuses to negotiate; routes
   to owner with recommendation.
6. **Bad outcome that already happened** (Carlos no-show, 1-star
   review) → review monitoring + draft public response + private apology
   + service credit, all in approval queue within an hour.
7. **End-of-day "what I got wrong today"** → built into every digest.

### Confidence-surfacing rules

The product does **not** display a confidence percentage on every line.
That creates alarm fatigue. Confidence is surfaced when:

- **Parts**: model number was not in the customer's history or the
  tenant's inventory.
- **Prices**: labor rate or part price differs >10% from the tenant's
  rolling-30-day average for similar items.
- **Urgency**: caller's vocabulary or affect is inconsistent with the
  classifier's confidence (e.g., flat tone + "it's 102° in here").
- **B2B account identification**: caller's phone number doesn't match a
  known account but they claim to represent one.
- **Brand voice**: the generated copy deviates from the locked tone
  profile (e.g., uses banned phrases or unusual register).

Anything else is shipped silently. The owner is the supervisor for
edge cases, not for the bulk of the work.

---

## 5. System architecture

### Updated architecture diagram

```
┌──────────────────────────────────────────────────────────────┐
│                       Channels                                │
│  Inbound Voice (Twilio) │ SMS │ MMS │ Web (audit only)        │
└──────────┬──────────┬──────────┬──────────┬──────────────────┘
           │          │          │          │
┌──────────▼──────────▼──────────▼──────────▼──────────────────┐
│                  Intake & Triage Layer                         │
│  Intent Classification │ Vulnerability Detector │ Severity     │
│  B2B Account Recognizer │ Dropped-Call Recovery                │
└──────────────────────┬────────────────────────────────────────┘
                       │
┌──────────────────────▼────────────────────────────────────────┐
│                  Conversation Layer                            │
│  Threads │ Messages │ Transcripts │ Clarifications             │
│  Linked Accounts (B2B) │ Customer History                      │
└──────────────────────┬────────────────────────────────────────┘
                       │
┌──────────────────────▼────────────────────────────────────────┐
│                  AI Orchestration                               │
│  Context Assembly │ Vertical-Pack Routing │ Task Selection      │
└──────────────────────┬────────────────────────────────────────┘
                       │
┌──────────────────────▼────────────────────────────────────────┐
│                  LLM Gateway                                    │
│  Provider Adapters │ Tier Routing │ Health │ Cache              │
│  ┌─────────┐ ┌──────────┐ ┌───────────┐                        │
│  │Tier 1   │ │Tier 2    │ │Tier 3     │                        │
│  │classify │ │proposals │ │estimates  │                        │
│  └─────────┘ └──────────┘ └───────────┘                        │
└──────────────────────┬────────────────────────────────────────┘
                       │
┌──────────────────────▼────────────────────────────────────────┐
│              Proposal Engine (Trust Boundary)                   │
│  Typed Contracts │ Confidence Markers │ Brand-Voice Validator   │
│  Negotiation Guardrails │ Expiry                                │
└──────────────────────┬────────────────────────────────────────┘
                       │
┌──────────────────────▼────────────────────────────────────────┐
│              ★ NEW: Supervisor Agent (review pass)              │
│  Re-scores Urgency │ Detects Pricing Anomalies │ Flags Edge     │
│  Cases │ Latency budget < 60s post-proposal                    │
└──────────────────────┬────────────────────────────────────────┘
                       │
┌──────────────────────▼────────────────────────────────────────┐
│              ★ NEW: SMS Approval Transport                       │
│  Renders proposals as SMS with one-tap actions │ Accepts        │
│  voice-dictated edit replies │ Tracks approval state            │
└──────────────────────┬────────────────────────────────────────┘
                       │ (approved only)
┌──────────────────────▼────────────────────────────────────────┐
│              Deterministic Execution                            │
│  Entity Mutations │ Idempotency │ Audit │ Rollback-safe         │
└──────────────────────┬────────────────────────────────────────┘
                       │
┌──────────────────────▼────────────────────────────────────────┐
│              Operational Data Layer                             │
│  Customers │ Accounts (B2B) │ Jobs │ Appointments │ Estimates  │
│  Invoices │ Payments │ Tenant-scoped │ RLS │ Audit │ Diffs     │
└──────────────────────┬────────────────────────────────────────┘
                       │
┌──────────────────────▼────────────────────────────────────────┐
│         Reporting & Learning (★ NEW: End-of-Day Digest)         │
│  AI Runs │ Prompt Versions │ Edit Deltas │ Correction Loop      │
│  Daily Digest Generator │ Weekly Summary │ Quality Metrics      │
└──────────────────────┬────────────────────────────────────────┘
                       │
┌──────────────────────▼────────────────────────────────────────┐
│              ★ NEW: Reputation Layer                             │
│  Google Business Polling │ Review Classifier │ Draft Response   │
│  Customer Re-engagement Proposals                               │
└─────────────────────────────────────────────────────────────────┘
```

★ = added or substantially changed in v2.

### Architectural principles

Carried from v1:
1. **Proposal-first safety** — AI creates typed proposals; deterministic
   services execute approved actions.
2. **Tenant isolation** — all entities, conversations, proposals, AI
   artifacts are tenant-scoped with RLS.
3. **Learning-ready data model** — AI runs, prompt versions, revisions,
   diffs preserved for quality improvement.
4. **Vertical-pack model** — HVAC/plumbing behavior layered on shared
   core.
5. **Provider-agnostic AI** — LLM gateway abstracts model providers;
   tiered routing optimizes cost/quality.

Added in v2:
6. **SMS-first surface** — every owner-facing interaction the product
   must be completable via SMS without opening the web app.
7. **Supervisor-agent review** — every high-stakes AI output (booking,
   quote, payment-related communication) gets a second pass from a
   cheaper classifier before reaching the owner or customer.
8. **Honest uncertainty** — the system surfaces its own confidence; the
   end-of-day digest reports what it learned and what it got wrong.

### Vertical pack architecture

Each pack provides:
- **Terminology and taxonomy** (HVAC parts vs. plumbing fittings)
- **Severity classifier** (e.g., "active leak > frozen no leak" for
  plumbing; "no AC + medical + heat" for HVAC)
- **Intake skill set** (e.g., MMS-to-quote for plumbing photo flow)
- **Estimate templates** (vertical-specific bundles)
- **Equipment-history awareness** (HVAC unit model + service age;
  plumbing fixture age)
- **Brand-voice defaults** (vertical-appropriate tone seed)

Packs are loaded per tenant; tenants can be in one or both verticals
(rare but allowed).

### Key invariants

- **Money**: integer cents, never floating point.
- **Time**: stored UTC, rendered in tenant timezone.
- **Entities**: every row has `tenant_id`; RLS enforced.
- **Mutations**: emit audit events.
- **AI calls**: route through LLM gateway.
- **Proposals**: typed Zod contracts; never auto-executed.
- **High-stakes outputs**: reviewed by supervisor agent before reaching
  owner/customer.
- **Owner-facing interactions**: completable via SMS.

---

## 6. Functional scope

### In scope for V1 (Waves 1–3)

**Intake & answering**
- Inbound voice call answering with shop-specific voice
- SMS triage and replies in the shop's voice
- MMS (photo) intake for plumbing
- Severity- and vulnerability-aware triage
- B2B account recognition
- Dropped-call SMS recovery

**Customer & job management**
- Customer + B2B account entities
- Service location, job, appointment entities
- Customer history and equipment history (HVAC)
- Internal notes

**Quoting**
- Estimate drafting from call recordings + customer history
- MMS-to-quote (plumbing photo flow)
- Confidence-surfaced line items
- SMS approval transport
- Vertical-pack templates and pricing

**Invoicing & payments**
- Invoice drafting from completed jobs + tech notes
- Stripe payment link generation
- Unpaid invoice follow-up (on-brand, on schedule)
- Partial payment handling

**Daily operations**
- Schedule visibility (no owner-facing dispatch board)
- Customer reminders + late-arrival heads-ups
- End-of-day digest with "what I wasn't sure about" section
- Tech "I'm out" one-tap status

**Trust & quality**
- Supervisor-agent review pass
- Brand-voice config (locked after onboarding)
- Correction-loop UX (owner edits → system learns)
- Google review monitoring + draft-response approval
- Audit trail of every AI action

**Languages**: English V1; Spanish in Wave 3.

### Out of scope for V1 (post-PMF)

- Customer self-service portal
- Multi-location aggregation / team hierarchies
- Outbound marketing / lifecycle automation
- Maintenance agreement management (light surface only in V1)
- Parts inventory & supplier integration
- Route optimization / geofencing
- Predictive maintenance / equipment-health AI
- Multi-location dispatch optimization
- Visual day-view dispatch board (for shops with dedicated dispatchers)

### Out of scope, ever

- Tax filing
- Payroll calculation (surface hours; QuickBooks/Gusto pays)
- Legal advice
- Vendor price negotiation
- HR / firing decisions
- AI-initiated discounting or scope changes without owner approval
- Anything that requires the owner to log into a separate dashboard for
  >30 seconds

---

## 7. Wave plan

V1 is delivered in three waves. v1 of this PRD was organized into 8 phases
(P0–P7); v2 re-sequences those phases into waves aligned to the customer-
visible product. See `docs/strategy/roadmap-audit.md` for the mapping
from old phases to new waves.

### Wave 1 — Foundation (in-flight; finish as planned)

**Goal**: production-ready platform, core entities, proposal engine,
LLM gateway. The owner cannot use it yet, but everything the AI back
office sits on is ready.

**Includes**:
- All of P0 (platform foundation, AI run logging, prompt registry,
  diff worker)
- All of P1 (core entities) + new `account_type` field on customer
  (pulled forward from P13)
- All of P2 (proposal engine + LLM gateway) + 3 new stories:
  - **SMS-Approval-Transport** (see §9)
  - **Confidence-Surfacing-Spec** (see §9)
  - **Negotiation-Guardrail-Handler** (see §9)

**Exit criteria**: A proposal can be created, dispatched to SMS,
approved via one-tap reply (or edited via voice dictation), and executed.
All proposal types from v1 plus the three new guardrail behaviors are
wired.

**Estimated**: 4–6 weeks remaining.

### Wave 2 — AI back office MVP (the heart of the product)

**Goal**: Mike's good Tuesday and Jenna's good Tuesday both work end-to-
end. The owner can stop opening their email and start running their day
from SMS.

**Includes**:
- **P4 vertical packs** (HVAC + plumbing) with three additions:
  - MMS-to-quote for plumbing
  - Severity-aware plumbing triage
  - HVAC equipment-history awareness
- **P5 invoice intelligence + payments**, plus:
  - **End-of-Day Digest** with "what I wasn't sure about" section
  - **Correction-Loop UX** (owner edits → system learns)
- **P7 integrations** (slimmed): Twilio SMS, Stripe payment links,
  **Google review monitoring + draft response** (new). QuickBooks deep
  sync deferred to Wave 4.
- **P2.5 (new): Supervisor Agent Review Pass**
- **P8 inbound calling agent** plus two additions:
  - **Dropped-Call SMS Recovery**
  - **Vulnerability-Aware Emergency Triage**
- **Brand-voice configurator** (in P4 or P2).

**Exit criteria**: A pilot customer (Mike-like or Jenna-like) runs their
business for two weeks without opening the web app for daily work.
Time-to-cash improves 30%+ vs. their baseline. The end-of-day digest is
their dashboard.

**Estimated**: 12–16 weeks (largest wave).

### Wave 3 — Beta hardening and launch

**Goal**: 10–25 beta customers running on the product. AI quality gates
met. Launch press-readiness.

**Includes**:
- P11 voice/UI parity (slimmed): Spanish (STT/TTS/classifier), lookup
  skills. UI compose forms deferred.
- P18 acceptance-criteria tests + bad-day simulation suite (see §12).
- Launch readiness checklist (subset of P7).
- Support tooling: AI run search, proposal lookup, customer activity
  view.

**Exit criteria**: 90% of pilot customers retain after week 4. AI
quality thresholds met (see §11). No P0 / P1 trust incidents in 14
consecutive days.

**Estimated**: 4–6 weeks.

### Wave 4 — Post-PMF expansion

**Goal**: Expand the ICP, deepen integrations, and add the second-user
experiences (dispatcher, spouse, larger shops).

**Includes** (in priority order, validated by Wave 3 customer signal):
- P3 conversation thread UI (for dispatcher persona)
- P6 dispatch board (for 3+-truck shops)
- P9 leads + service agreements
- QuickBooks deep sync
- P12 field operations (route optimization)
- P13 multi-location
- P10 customer portal (only if customer demand validated; default: no)
- P14 inventory + parts
- P15–P19 in priority order

**Not estimated**; driven by Wave 3 learnings.

---

## 8. Critical path and dependencies

The single most important sequence:

```
P0 platform foundation
  ↓
P1 core entities + account_type
  ↓
P2 proposal engine + LLM gateway
  ↓
  ┌──→ SMS-Approval-Transport ──┐
  ├──→ Confidence-Surfacing ────┤
  └──→ Negotiation-Guardrail ───┘
  ↓
P4 vertical packs (HVAC + plumbing + MMS + severity + equipment)
  ↓
  ┌──→ P5 invoice intelligence
  ├──→ P8 inbound calling agent
  ├──→ P2.5 supervisor agent ← critical: cannot ship to customers without
  ├──→ End-of-day digest        this; trust mechanism is incomplete
  ├──→ Dropped-call recovery
  ├──→ Vulnerability triage
  ├──→ Correction-loop UX
  └──→ Google review monitoring
  ↓
Wave 2 exit: Mike's day works end-to-end on SMS
  ↓
Wave 3 hardening → external beta
```

The **supervisor agent (P2.5)** is the most under-prioritized story
relative to its importance. It is the difference between an AI assistant
that occasionally embarrasses the owner and one that doesn't.

---

## 9. New and amended stories

Per the audit (`docs/strategy/roadmap-audit.md`), the following stories
are new or amended in v2. **Stories from v1's execution catalog that are
not listed here are unchanged.**

> The full dispatchable story specs (with Allowed Files, Build Prompts,
> Review Prompts, Automated Checks, and Required Tests) for the eleven
> new stories below live at
> `docs/stories/wave-2-strategic-stories.md`. The PRD §9 summary you are
> reading is the strategic spec; the story file is the engineering
> execution artifact. Use `/dispatch-story <ID>` (e.g.
> `/dispatch-story P2-034`) to send a story to an isolated build agent.

### NEW stories

#### N-001 / **P2-034** — SMS-Approval-Transport `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | Proposal Engine |
| Wave | 1 |
| Dependencies | P2-001 (proposal entity), P2-002 (typed contracts), P0-014 (webhook base) |
| Allowed Files | `packages/api/src/proposals/sms/**`, `packages/api/src/sms/**`, `packages/api/migrations/*proposal_sms*` |

**Build prompt**: Implement an SMS rendering and approval transport for
every proposal type. For each proposal, render a concise SMS body with
the proposal summary, key fields, and three reply tokens: APPROVE, EDIT,
REJECT. Inbound SMS replies are parsed: APPROVE → mark proposal
approved; REJECT → mark rejected with reason; EDIT → open an edit
session that accepts a voice memo (audio MMS or text) interpreted as a
delta against the proposal. Track delivery, read receipts (where Twilio
supports), and approval state on the proposal.

**Acceptance criteria**:
- Every proposal type has an SMS render template.
- One-tap reply transitions the proposal state correctly.
- Voice-dictated edits produce a structured delta on the proposal
  before re-rendering for approval.
- Idempotent: duplicate inbound SMS for the same proposal is a no-op.
- All SMS interactions audit-logged.

**Non-goals**: Rich-media approval cards (deferred); MMS attachments in
proposal SMS (deferred); group-SMS approval (out of scope).

#### N-002 / **P2-035** — Confidence-Surfacing-Spec `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | Proposal Engine |
| Wave | 1 |
| Dependencies | P2-012 (confidence storage) |
| Allowed Files | `packages/api/src/proposals/confidence/**`, `packages/api/src/ai/confidence/**` |

**Build prompt**: Replace generic "confidence score" UX with a typed
confidence-marker system. Markers are emitted by AI tasks when:
(a) a part model is not in tenant inventory or customer history;
(b) a labor rate or part price differs >10% from the tenant's rolling-
30-day average for similar items;
(c) urgency classification confidence is <80%;
(d) B2B account claim is unverified;
(e) brand-voice deviation is detected.
Markers surface in both the SMS approval message and the web audit view.
No "X% confident" badges anywhere in the product.

**Acceptance criteria**:
- Markers attached to proposal line items where applicable.
- SMS template includes a concise "I'm not sure about: …" line when
  any marker is present.
- Confidence markers are logged with proposal outcomes for retraining.

**Non-goals**: Global confidence percentage display; user-configurable
thresholds in V1.

#### N-003 / **P2-036** — Negotiation-Guardrail-Handler `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | Proposal Engine |
| Wave | 1 |
| Dependencies | P2-013 (low-confidence policy), N-001 |
| Allowed Files | `packages/api/src/proposals/guardrails/**`, `packages/api/src/conversations/negotiation/**` |

**Build prompt**: Add a guardrail layer that detects negotiation
intents in inbound messages — discount requests, scope-change
requests, "let me talk to your manager," refund requests, deadline
threats. The AI never responds with a substantive answer to these. It
acknowledges politely ("Let me check with [owner first name] on that —
I'll get back to you within the hour") and emits a proposal to the
owner with a recommendation (e.g., "don't discount: high-LTV customer
who will come back; offer $100 courtesy + Friday slot instead").

**Acceptance criteria**:
- Detection on text and voice channels.
- Acknowledgment message uses the locked brand voice.
- Owner receives the proposal via SMS within 30 seconds of detection.
- AI cannot generate discount or scope-change commitments without
  approved proposal.

**Non-goals**: Negotiation playbooks per tenant (V2); price-floor
configuration (V2 — V1 just blocks discounts).

#### N-004 / **P2-037** — Supervisor Agent Review Pass `[M]`

| Attribute | Value |
|-----------|-------|
| Layer | AI Orchestration (new sub-layer) |
| Wave | 2 |
| Dependencies | P2-007 (orchestration), P2-027 (gateway), P5-001 (invoice proposals) |
| Allowed Files | `packages/api/src/ai/supervisor/**`, `packages/api/src/ai/runs/**`, `packages/api/migrations/*supervisor*` |

**Build prompt**: Implement a second-pass classifier that reviews every
booking, quote, and invoice proposal produced by the primary system,
before the proposal reaches the owner's SMS queue. Uses a cheaper /
faster model (Tier 1). Checks for:
- **Missed urgency**: caller signals (vocabulary, age, weather, medical
  mention) inconsistent with the booking's scheduled time.
- **Pricing anomalies**: total or line items differ >20% from rolling
  averages for similar jobs.
- **Brand-voice drift**: message uses banned phrases or unusual
  register.
- **Account-routing errors**: residential proposal for a known B2B
  account, or vice versa.

Flags become confidence markers (per N-002). If a critical flag fires
(e.g., medical mention not escalated), the proposal is held and a
direct owner alert is sent.

**Acceptance criteria**:
- Review completes within 60 seconds of proposal creation in P95.
- Critical-flag holds reach owner via direct alert (not just queued).
- All reviews logged to AI runs for measurement.
- Supervisor agent uses a different model than the primary task
  (configurable per task type).

**Non-goals**: Supervisor agent for SMS-only conversations (V2);
custom rules per tenant (V2).

#### N-005 / **P5-020** — End-of-Day Digest Generator `[M]`

| Attribute | Value |
|-----------|-------|
| Layer | Reporting & Learning |
| Wave | 2 |
| Dependencies | P1 entities, P2 proposals, P5 invoices, N-002 |
| Allowed Files | `packages/api/src/digest/**`, `packages/api/src/workers/digest.*`, `packages/api/migrations/*digest*` |

**Build prompt**: Generate a daily SMS summary delivered between 6pm
and 9pm in tenant timezone. Content:
- Jobs completed (count, revenue invoiced, revenue collected)
- Quotes sent (count, pipeline value)
- Follow-ups sent on unpaid invoices (count, outcomes)
- Tomorrow's schedule confirmation
- **"What I wasn't sure about today"** section: lists all proposals
  where confidence markers fired and what the owner did about them.
- **"What I learned today"** section: lists corrections applied to
  prior outputs (e.g., "labor rate is $145 going forward").
- Single approve-style reply ("Looks good" / "Tell me more") for
  feedback.

**Acceptance criteria**:
- Digest sent within the configured window; failed sends retry up to
  3 times.
- Digest content is deterministic from the day's data; regenerable.
- "What I wasn't sure about" section omitted if zero items.
- Owner reply triggers a brief follow-up if requested.

**Non-goals**: Weekly digest in V1 (Wave 3); email digest (Wave 3);
per-user customization of digest contents (V2).

#### N-006 / **P7-026** — Google Review Monitoring + Draft Response `[M]`

| Attribute | Value |
|-----------|-------|
| Layer | Reputation |
| Wave | 2 |
| Dependencies | P0-014 (webhook base), N-001, P2-002 |
| Allowed Files | `packages/api/src/reputation/**`, `packages/api/src/workers/google-reviews.*`, `packages/api/migrations/*review*` |

**Build prompt**: Poll Google Business Profile for new reviews on a 15-
minute interval. For each new review, classify sentiment and content
(praise / specific complaint / vague complaint / wrong-business). For
non-positive reviews, draft a public response in the locked brand voice
and a private apology message to the customer if identifiable. Create a
proposal containing both drafts plus an optional service-credit
suggestion. Owner approves via SMS.

**Acceptance criteria**:
- New reviews detected within 30 minutes of posting.
- Drafted public response is on-brand and addresses the specific
  complaint where possible.
- Customer matching to existing accounts attempted; flagged when
  uncertain.
- Owner can approve, edit, or reject via SMS.

**Non-goals**: Yelp, Facebook, Nextdoor monitoring (Wave 3); proactive
review-request sending (Wave 3).

#### N-007 / **P8-015** — Dropped-Call SMS Recovery `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | Intake |
| Wave | 2 |
| Dependencies | P8 inbound calling agent |
| Allowed Files | `packages/api/src/voice/recovery/**`, `packages/api/src/sms/recovery/**` |

**Build prompt**: Detect when an inbound voice session ends without
resolution (caller hung up, dropped, audio quality failure, system
error) and, within 60 seconds, send the caller an SMS in the shop's
voice with any partial transcript context. Track conversation
continuity (the SMS reply belongs to the same intake thread as the
dropped call).

**Acceptance criteria**:
- Drop detected within 5 seconds of session end.
- SMS sent within 60 seconds in P95.
- Inbound SMS reply is threaded to the original intake.
- No SMS sent if the caller successfully booked or was transferred to
  the owner.

**Non-goals**: Outbound voice callback (V2); recovery for SMS-initiated
conversations (different problem).

#### N-008 / **P8-016** — Vulnerability-Aware Emergency Triage `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | Intake |
| Wave | 2 |
| Dependencies | P8 inbound calling agent, customer entity |
| Allowed Files | `packages/api/src/voice/triage/**`, `packages/api/src/ai/vulnerability/**` |

**Build prompt**: Extend the inbound calling agent's escalation skill
to weigh vulnerability signals in urgency classification:
- **Age**: caller mentions or known to be >65 (from customer record).
- **Weather**: tenant's locale has extreme temperature in last 24h
  (>100°F or <20°F).
- **Medical**: caller mentions oxygen, dialysis, breathing, illness, or
  similar.
- **Property type**: known B2B account flagged "occupied" (e.g.,
  property manager dealing with residents).

Vulnerability + urgency → voice patch to owner's cell with a 5-second
context preface, **not booking**. Vulnerability alone (no urgency) →
high-priority booking, owner notified.

**Acceptance criteria**:
- Signals detected from utterance content + customer record + weather
  API.
- Patch-through latency <30 seconds.
- Owner receives context preface before being connected to caller.
- Falls back to high-priority booking if owner unreachable in 60s.

**Non-goals**: Real-time vital monitoring (not our domain); medical
priority routing (we don't claim medical authority).

#### N-009 / **P2-038** — Correction-Loop UX `[M]`

| Attribute | Value |
|-----------|-------|
| Layer | Reporting & Learning |
| Wave | 2 |
| Dependencies | P0-018 (diff worker), P2-005 (approve/reject/edit), N-005 |
| Allowed Files | `packages/api/src/learning/corrections/**`, `packages/api/src/ai/prompts/**` |

**Build prompt**: When the owner edits a proposal, extract structured
lessons from the edit and apply them forward. Examples:
- Labor rate change → update tenant's default labor rate.
- Part price change → update tenant's price for that SKU.
- Banned phrase rejected → add to tenant brand-voice negative-prompt.
- Scope re-classified → adjust vertical-pack template selection
  weight.

Surfaced in the end-of-day digest as "what I learned today." The
correction is auditable and reversible.

**Acceptance criteria**:
- Lessons extracted from at least the four edit categories above.
- Forward-applied within the current day.
- Owner can review and undo any learned change via web audit.
- Digest references the learned change in the same day's report.

**Non-goals**: Cross-tenant learning (privacy concern); model fine-
tuning from corrections (V2 — this is prompt-level adjustment only).

#### N-010 / **P6-028** — Tech "I'm Out" One-Tap Status `[XS]`

| Attribute | Value |
|-----------|-------|
| Layer | Field Ops |
| Wave | 2 |
| Dependencies | P1-008 (technician assignment) |
| Allowed Files | `packages/api/src/sms/tech-status/**`, `packages/api/src/scheduling/**` |

**Build prompt**: Allow technicians to mark themselves out (sick,
emergency, unavailable) via a single SMS keyword reply. System
re-routes their day's appointments through proposal flow (reschedule
proposals to owner). Prevents the Carlos-no-show scenario from §4.

**Acceptance criteria**:
- Tech texts "OUT" or "SICK" → status updated.
- Day's appointments enter reschedule proposal queue immediately.
- Customer-facing reschedule SMS drafted in brand voice.
- Owner approves the cascading reschedules in one tap each.

**Non-goals**: Multi-day out status (V2 — V1 is same-day only); partial
day (e.g., out for the afternoon).

#### N-011 / **P4-015** — Brand-Voice Configurator `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | Onboarding / Tenant Settings |
| Wave | 2 |
| Dependencies | P4 vertical packs |
| Allowed Files | `packages/api/src/tenants/brand/**`, `packages/web/src/onboarding/brand/**` |

**Build prompt**: During onboarding, capture brand-voice settings:
register (formal / friendly / casual), preferred opening lines, sign-
off, banned phrases, shop persona name (e.g., "M&R Mechanical's
office"). Validate all subsequent AI utterances against the locked
profile. Allow updates only via explicit web action (not SMS), and
re-validate.

**Acceptance criteria**:
- Onboarding flow captures all six fields.
- Every AI-generated message tagged with brand-voice version used.
- Detection of deviation triggers confidence marker (per N-002).
- Voice changes audit-logged.

**Non-goals**: Multiple brand voices per tenant (V2); per-channel voice
variation (V2).

### AMENDED stories

These v1 stories require a spec change to align with v2 decisions.
Implementation owners must read both the v1 story (in
`docs/PRD-execution-catalog.md`) and the amendment here.

#### AMEND P1-001 — Customer entity + CRUD

**Amendment**: Add `account_type` enum field with values `residential`,
`commercial`, `property_manager`. Default `residential`. Add
`parent_account_id` nullable FK for commercial sub-accounts. Migration
must be safe on existing data (all current rows default to
`residential`).

#### AMEND P2-007 — AI task orchestration baseline

**Amendment**: Every orchestrated task that produces a proposal must
hand off to the supervisor agent (N-004) before SMS dispatch (N-001).
Skip is permitted only for proposals tagged `tier=internal`.

#### AMEND P2-012 — Confidence storage and display

**Amendment**: Replace the planned numeric-confidence display with the
typed marker system from N-002. Storage remains; display changes.

#### AMEND P4 vertical-pack stories

**Amendment**: All P4-002 (HVAC) and P4-003 (plumbing) stories must
include:
- HVAC: equipment-history awareness (unit model + service age from
  customer history feeds context assembly).
- Plumbing: MMS-to-quote intake path (photo + customer history →
  draft quote with confidence markers).
- Plumbing: severity classifier (active leak > frozen no leak >
  routine).
- Both: brand-voice validation (per N-011).

#### AMEND P8 (inbound calling agent)

**Amendment**: All P8 escalation stories must integrate vulnerability-
aware triage (N-008). Dropped-call recovery (N-007) is a sibling
story, not an extension.

#### AMEND P10-001 (customer portal) — **DEFER**
### Story Details — LLM Gateway (P2-027–P2-031)

The gateway and its surrounding modules were scaffolded out-of-band before these stories were written. These specs reflect the actual remaining work: composing, integrating, and persisting — not greenfield construction. See `packages/api/src/ai/gateway/` for the existing scaffolding.

#### P2-027 — Provider-agnostic LLM gateway `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | AI/Platform |
| AI Buildability | High |
| Human Review | Heavy |
| Dependencies | P0-015, P0-016, P2-007 |
| Allowed Files | `packages/api/src/ai/gateway/**`, `packages/api/src/ai/providers/**`, `packages/api/src/ai/ai-run.ts`, `packages/api/src/ai/pg-ai-run.ts`, `packages/api/src/app.ts` |

**Build prompt:** Gateway, factory, and provider abstraction already exist (`packages/api/src/ai/gateway/{gateway,factory}.ts`, `packages/api/src/ai/providers/openai-compatible.ts`) and the single instance is wired in `packages/api/src/app.ts`. Close the three gaps that prevent it from being the true canonical chokepoint:
1. **Wire AI-run logging into `LLMGateway.complete()`** — every call writes an `ai_runs` row (`pending` → `running` → `completed`/`failed`) with `taskType`, resolved `model`, `promptVersionId` (when supplied), `tokenUsage`, `durationMs`, `correlationId`. Inject `AiRunRepository` via constructor; tests default to `InMemoryAiRunRepository`, prod uses `PgAiRunRepository`.
2. **Delete `gateway/types.ts`.** Canonical types (`LLMRequest`/`LLMResponse`/`LLMMessage`, `complete()`-based `LLMProvider`) live in `gateway.ts`. Move `GatewayConfig`/`TaskRouteConfig` only if still referenced; drop the `chat()`-based duplicate; fix imports in `routing-config.ts`, `complexity-classifier.ts`, and `index.ts`.
3. **Add a CI guard.** Grep for `new OpenAI(` and `client.chat.completions.create` outside `ai/gateway/` and `ai/providers/`; fail the build if any match.

**Automated checks:** `gateway.complete() writes a pending then a completed AiRun on success; writes a failed AiRun with errorMessage on provider error; correlationId propagates from request to AiRun row; resolved model (not request override placeholder) recorded on AiRun; type-duplication test confirms no ChatRequest/ChatResponse symbol is exported; CI grep guard fails on a planted direct provider call; all existing task handler tests pass unchanged`

**Acceptance criteria:**
- Every `gateway.complete()` call produces exactly one `ai_runs` row via `AiRunRepository`.
- AiRun lifecycle and fields populated as above.
- `gateway/types.ts` removed; no symbol it exported is imported anywhere.
- `gateway/index.ts` re-exports only the `LLMRequest`/`LLMResponse` family.
- CI guard: zero direct provider calls outside the gateway/providers tree.

**Non-goals:** No new providers. No routing/retry/cache/failover changes (covered by P2-028/029/031). No AI-run viewing UI.

---

#### P2-028 — Task-complexity-based model routing `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | AI/Orchestration |
| AI Buildability | Medium |
| Human Review | Heavy |
| Dependencies | P2-027, P2-008 |
| Allowed Files | `packages/api/src/ai/gateway/{gateway,router,routing-config,complexity-classifier}.ts`, `packages/api/src/config/ai-routing.ts` |

**Build prompt:** Tier table (`packages/api/src/config/ai-routing.ts`), `enrichRequestWithRouting()` (`packages/api/src/ai/gateway/router.ts`), and complexity classifier already exist but are not composed into `LLMGateway.complete()`. Make routing automatic:
1. Replace the inline `LLMGateway.resolveModel()` with a call into `enrichRequestWithRouting()` so `taskType → tier → model + temperature + maxTokens` happens before provider dispatch. Explicit `request.model` still wins (caller override).
2. Add `LLMGatewayConfig.tenantOverrides?: Record<tenantId, Partial<AIRoutingConfig>>` for per-tenant tier maps.
3. Emit a structured `model_routing_decision` log line: `{taskType, resolvedTier, resolvedModel, overrideSource: 'request'|'tenant'|'default'}`.
4. Unmapped `taskType` resolves to `standard` tier with one warning log per process per taskType.

**Automated checks:** `routing test per tier (lightweight/standard/complex); request.model override beats tier mapping; tenant override beats default config; unmapped taskType resolves to standard with single warning; AiRun.model equals resolved model on every call`

**Acceptance criteria:**
- `gateway.complete({ taskType: 'intent_classification' })` resolves to the lightweight-tier model with no caller-supplied `model`.
- `gateway.complete({ taskType: 'draft_estimate' })` resolves to the complex-tier model.
- Tenant override applied when `tenantOverrides[tenantId]` is present.
- AiRun.model always equals the *resolved* model.

**Non-goals:** No automatic complexity inference from message content (classifier stays opt-in). No cost-based routing.

---

#### P2-029 — Provider health monitoring + failover `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | AI/Operations |
| AI Buildability | High |
| Human Review | Moderate |
| Dependencies | P2-027, P0-008 |
| Allowed Files | `packages/api/src/ai/gateway/{factory,gateway,breaker,retry,deadline,failover,health,tenant-quota}.ts`, `packages/api/src/routes/health.ts` |

**Build prompt:** Resilience modules (breaker, retry, deadline, failover, tenant-quota, health) already exist but `createLLMGateway()` doesn't compose them. Wire them in and surface health:
1. Compose order, innermost to outermost: `provider → retry → deadline → breaker → failover → tenant-quota → LLMGateway`. Each wrapper preserves the `LLMProvider` interface so wrapping order can be changed without touching call sites.
2. Add `GET /api/health/ai` returning `{providers: [{name, available, breakerState, lastError, lastSuccessAt}]}`.
3. Emit Prometheus metrics: `gateway_breaker_state{provider, state}`, `gateway_retry_attempts_total{provider, taskType, outcome}`, `gateway_failover_total{from_provider, to_provider}`.
4. Distinguish error envelopes: single-provider failure → `LLM_PROVIDER_ERROR` (existing); full failover exhausted → new `LLM_PROVIDER_UNAVAILABLE`.
5. Populate `LLMResponse.providerPath` on success; mirror into AiRun output snapshot for postmortems.

**Automated checks:** `breaker opens after N consecutive failures, short-circuits subsequent calls, half-opens after cooldown; retry honors exponential backoff and aborts on AbortSignal; deadline cancels in-flight provider call via signal; failover advances on 5xx/network but not on 4xx; tenant-quota blocks over-tier calls with 429 envelope; /api/health/ai reflects current breaker state; AiRun.outputSnapshot.providerPath populated when failover engages`

**Acceptance criteria:**
- Default `createLLMGateway()` returns a gateway with the full resilience stack composed.
- Breaker behavior: opens, short-circuits, half-opens, recovers — all driven by configurable thresholds.
- `/api/health/ai` returns per-provider state.
- Failover never engages on validation errors.
- `providerPath` surfaces in logs and AiRun rows.

**Non-goals:** No active health probing (passive observation only). No latency-based provider re-ordering. No tenant-quota admin UI.

---

#### P2-030 — Model shadow comparison framework `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | AI/Analytics |
| AI Buildability | Medium |
| Human Review | Moderate |
| Dependencies | P2-027, P2-020, P0-015 |
| Allowed Files | `packages/api/src/ai/evaluation/shadow-comparison.ts`, `packages/api/src/ai/evaluation/pg-shadow-comparison.ts`, `packages/api/src/ai/gateway/factory.ts`, `packages/api/src/routes/evaluation.ts`, `packages/api/migrations/*shadow*` |

**Build prompt:** `ShadowComparisonGateway` and the in-memory store already exist; opt-in via `SHADOW_LLM_ENABLED` and wrapped in `packages/api/src/ai/gateway/factory.ts`. Make it durable and queryable:
1. Add `shadow_comparisons` table: `id, tenant_id, ai_run_id (FK), shadow_model, primary_response_text, shadow_response_text, primary_latency_ms, shadow_latency_ms, primary_token_usage JSONB, shadow_token_usage JSONB, divergence_score NUMERIC (nullable, written by P2-020 eval), created_at`. RLS on `tenant_id`. Index on `(tenant_id, ai_run_id)` and `(tenant_id, created_at DESC)`.
2. Implement `PgShadowComparisonStore` mirroring the in-memory interface.
3. Factory swaps to PG store when `DATABASE_URL` set and `SHADOW_LLM_ENABLED=true`; otherwise falls back to in-memory.
4. Add `GET /api/evaluation/shadow-comparisons?taskType=&limit=&cursor=` (owner/admin only, paginated). Apply existing PII redaction (`voice-audit` module) before persistence.

**Automated checks:** `PgShadowComparisonStore round-trip; sampling rate respected (statistical test over 1000 calls — within ±2σ of target rate); shadow-provider failure never blocks primary response; comparison row links to ai_run_id; tenant isolation test on read API; PII redacted before insert`

**Acceptance criteria:**
- With `SHADOW_LLM_ENABLED=true` and `SHADOW_LLM_SAMPLING_RATE=0.1`, ~10% of `gateway.complete()` calls produce a `shadow_comparisons` row.
- Each row links to its `ai_run_id`; both responses persisted in full.
- Shadow-provider error logs at `warn`; primary response always returned.
- Read API enforces RLS; cross-tenant returns empty.
- PII redaction applied pre-insert.

**Non-goals:** No automated divergence scoring (P2-020's job, consuming this table). No shadow-comparison dashboard UI.

---

#### P2-031 — Response caching for deterministic tasks `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | AI/Platform |
| AI Buildability | High |
| Human Review | Moderate |
| Dependencies | P2-027 |
| Allowed Files | `packages/api/src/ai/gateway/{cache,redis-cache-store,factory}.ts`, `packages/api/src/config/cache.ts` |

**Build prompt:** `CachingGatewayWrapper` exists (`packages/api/src/ai/gateway/cache.ts`) but is not wired into the default factory and only has an in-memory store. Make the cache real:
1. Add `RedisCacheStore` implementing `CacheStore`. Connection from `REDIS_URL`; fall back to `InMemoryCacheStore` when unset.
2. `createLLMGateway()` wraps the assembled gateway (post-resilience, so cache sits *outside* breaker/retry — a cache hit is free and shouldn't burn breaker budget) with `CachingGatewayWrapper` when `AI_CACHE_ENABLED=true`. Default deterministic set: `intent_classification`, `entity_extraction`, `transcript_normalization`, `extract_categories`.
3. Propagate `LLMResponse.cached: true` through resilience wrappers so callers and AiRun rows see it.
4. Prometheus metrics: `gateway_cache_hits_total{taskType}`, `gateway_cache_misses_total{taskType}`.
5. Verify `createCacheKey()` still includes `tenantId` after factory composition changes (currently true — guard with test).

**Automated checks:** `cache hit returns cached=true; cache hit still writes an AiRun row marked cached: true (auditability preserved); cache miss falls through; TTL expiry forces re-fetch; non-deterministic taskTypes bypass cache entirely; cross-tenant cache key isolation; RedisCacheStore JSON round-trip; hit/miss counters increment correctly`

**Acceptance criteria:**
- Identical `(tenantId, taskType, model, messages)` requests hit cache on second call within TTL.
- Cache hit writes a *separate* AiRun row with `cached: true` so audit is never blind.
- Non-deterministic taskTypes never touch cache.
- Cross-tenant requests with identical messages do not share entries.
- `AI_CACHE_ENABLED=false` (default in dev) skips cache wrapping entirely — zero overhead.

**Non-goals:** No semantic-similarity caching (exact-match only). No cache invalidation API. No pre-warming.

---

**Amendment**: Defer indefinitely. The strategy commits to SMS, not
portal. Re-evaluate only if Wave 3 customer signal demands it.

#### AMEND P10-002 (executive dashboard) — **REPLACE**

**Amendment**: Replaced by N-005 end-of-day digest. The digest is the
dashboard.

### Deferred / cut stories

| Story | Action | Rationale |
|-------|--------|-----------|
| P6 (dispatch board, full) | Defer to Wave 4 | Owner-operators don't dispatch; visual day-view is wrong artifact for ICP. |
| P9 (lead pipeline + agreements) | Defer to Wave 4 | Validate demand first; not in day-in-the-life. |
| P10-001 (customer portal) | Cut from V1 | Customers want SMS, not portal. |
| P10-002 (exec dashboard) | Replace with N-005 | Digest is the dashboard. |
| P12 (field operations: route opt, offline) | Defer to Wave 4 | Real, but post-PMF. |
| P13 (multi-location) | Defer to Wave 4; pull only `account_type` field forward | Not ICP for V1. |
| P14 (inventory, full) | Defer to Wave 4 | Owner-operator carries parts in the truck. |
| P15–P19 | Defer to Wave 4 | Premium / hardening tiers; post-PMF. |

---

## 10. Data model changes (summary)

Net new tables / columns introduced by v2 stories:

| Table | Source | Purpose |
|-------|--------|---------|
| `customers.account_type` (enum) | AMEND P1-001 | B2B vs residential routing. |
| `customers.parent_account_id` (FK) | AMEND P1-001 | Commercial sub-accounts. |
| `proposals.confidence_markers` (JSONB) | N-002 | Typed uncertainty markers. |
| `proposals.sms_thread_id` (FK) | N-001 | Approval transport linkage. |
| `proposal_sms_events` | N-001 | Approval state transitions via SMS. |
| `supervisor_reviews` | N-004 | Review pass results + flags. |
| `digest_entries` | N-005 | Per-day digest content + status. |
| `digest_send_log` | N-005 | Delivery + retry tracking. |
| `reputation_reviews` | N-006 | Google review polling + state. |
| `reputation_response_proposals` | N-006 | Draft responses awaiting approval. |
| `correction_lessons` | N-009 | Structured corrections from edits. |
| `tenants.brand_voice` (JSONB) | N-011 | Locked tone profile. |
| `brand_voice_versions` | N-011 | History + rollback. |
| `tech_status_events` | N-010 | "I'm out" history. |
| `vulnerability_signals` | N-008 | Per-call vulnerability scores. |

All tables follow standard tenant_id + RLS + audit conventions
(invariants in §5).

---

## 11. Success metrics

### North star

**Owner hours returned per week.** Measured by surveying pilot
customers in Wave 2 and Wave 3 with a structured time-diary baseline
(pre-product) and re-measurement at 4 and 8 weeks.

**Target**: 12+ hours/week saved at week 8 for the median pilot.

### Day-in-the-life KPIs (per persona)

For Mike (HVAC, 2 trucks):

| Metric | Baseline (typical) | Target (Wave 2 exit) |
|--------|---------------------|----------------------|
| Calls answered during work hours | ~40% | 100% |
| Quotes drafted within 4 hours of intake | ~30% | >90% |
| Invoices sent within 24 hours of completion | ~50% | >90% |
| Time-to-cash (median days, invoice → paid) | 14–21 | <10 |
| Owner SMS approvals/day | n/a | <15 (sustainable) |
| Owner SMS approval median latency | n/a | <10 minutes during business hours |

For Jenna (plumbing, solo):

| Metric | Baseline | Target |
|--------|----------|--------|
| Frozen-pipe-season calls answered | <30% | 100% |
| B2B property-manager calls routed correctly | n/a | >95% |
| Photo-to-quote median time | 4–24h | <2h |
| Owner SMS approvals/day | n/a | <12 |

### AI quality gates

Inherited from v1 PRD, retained:

| Metric | Threshold | Gate |
|--------|-----------|------|
| Estimate proposal approval rate | ≥70% | Wave 2 exit |
| Clean approval rate (no edits) | ≥30% | Wave 2 exit |
| Invoice proposal approval rate | ≥75% | Wave 2 exit |
| Proposal execution success | >99% | Wave 1 exit |
| LLM gateway availability | >99.5% | Wave 1 exit |

New in v2:

| Metric | Threshold | Gate |
|--------|-----------|------|
| Supervisor agent critical-flag false-positive rate | <5% | Wave 2 exit |
| Supervisor agent critical-flag false-negative rate | <2% on labeled set | Wave 2 exit |
| Dropped-call SMS recovery latency (P95) | <60s | Wave 2 exit |
| Vulnerability triage correct-escalation rate | >95% on labeled set | Wave 2 exit |
| Brand-voice deviation detection precision | >85% | Wave 2 exit |
| End-of-day digest delivery rate | >99% within window | Wave 2 exit |
| Google review draft-response approval rate | >70% | Wave 2 exit |

### Business metrics

| Metric | Wave 2 target | Wave 3 target |
|--------|---------------|---------------|
| Pilot customers active | 3 | 10–25 |
| Week-4 retention | 80% | 90% |
| MRR per customer | $300–500 | $300–500 |
| Time from signup to first AI-handled call | <48h | <24h |
| NPS (pilot) | n/a | >50 |

---

## 12. Testing and quality

### Inherits from v1

The testing framework, coverage thresholds, and CI pipeline from v1
(`docs/PRD-execution-catalog.md` §"Testing Strategy") remain in force.
Highlights:

- Vitest, Supertest, Testing Library, Playwright (Wave 3+),
  testcontainers
- 95% coverage on billing engine, 90% on proposal execution + auth
- Required tests per story: happy path, validation, tenant isolation,
  permissions, edge cases

### New in v2

**Bad-day simulation suite.** A dedicated test suite that simulates each
of the seven failure modes from §4 and verifies the recovery flow
end-to-end:

| Simulation | Asserts |
|-----------|---------|
| Stale labor rate | Proposal flagged in queue, rate update prompted. |
| Hallucinated part | Confidence marker fires; Carlos-ask flow triggers. |
| Flat-voice elder caller | Supervisor agent catches; owner alerted. |
| Mid-call audio failure | SMS recovery within 60s. |
| Customer discount request | Guardrail blocks; owner proposal generated. |
| 1-star Google review | Polled, classified, draft proposal in queue within 30 min. |
| End-of-day digest | "Wasn't sure about" + "learned today" sections populate correctly. |

**SMS approval flow tests** (new test category):
- Every proposal type renders to SMS within 320-character soft limit
  (split if longer).
- One-tap reply tokens parse correctly across major carriers.
- Voice-dictated edit replies produce structured deltas.
- Duplicate inbound SMS for same proposal is idempotent.

**Brand-voice regression tests**:
- A golden dataset of "would Mike say this?" examples; >85% pass
  before Wave 3.
- Banned-phrase detection regression.

### Chaos / load (Wave 3)

- 50 concurrent tenants, 100 req/sec
- Inbound voice surge: 30 calls/min sustained for 10 min (simulating
  Phoenix afternoon peak)
- LLM gateway: simulate primary-provider outage; verify automatic
  failover within 5s without dropped proposals

---

## 13. Risk register

Top 10 risks, ordered by likelihood × impact.

| # | Risk | Mitigation | Owner |
|---|------|-----------|-------|
| 1 | AI confidently mis-quotes and owner approves without reading; customer angry. | Confidence markers (N-002) on price/part anomalies; supervisor agent flags out-of-pattern totals. | Eng |
| 2 | Voice quality / accent / kid-screaming caller is mis-understood; bad booking made. | Dropped-call SMS recovery (N-007); supervisor agent re-classifies; confidence marker on urgency. | Eng |
| 3 | Owner ignores SMS approvals during a busy day; backlog grows. | Approval-count target <15/day; digest summarizes pending. Onboarding sets expectations. | Product |
| 4 | Pilot customer churns because "it's not magic enough" — wanted full autonomy. | Manage expectations in sales: this is approval-gated. The autonomy story is intentional. | GTM |
| 5 | Supervisor agent has high false-positive rate; alert fatigue. | <5% target; tune in pilot; allow per-tenant calibration in Wave 3. | Eng |
| 6 | Google Business API limits / changes; review monitoring breaks. | Polling with backoff; fallback to manual; clear "monitoring degraded" banner. | Eng |
| 7 | LLM provider deprecates a model mid-quarter; quality regression. | Gateway abstraction; shadow comparison (P2-030); pinned model versions. | Eng |
| 8 | Customer's phone number changes; B2B account lost; routing breaks. | Account-recognition is multi-signal (name, address, vocab) not just phone; flag low-confidence matches. | Eng |
| 9 | Vulnerability triage misses a real medical emergency; reputational + legal risk. | Conservative threshold; vulnerability alone → high-priority booking + owner notify, not booking-as-normal. Document non-medical disclaimer. | Legal + Product |
| 10 | Owner edits brand voice frequently mid-week; AI sounds inconsistent. | Brand-voice changes are explicit web actions, audit-logged, with a 15-min cool-down before propagation. | Product |

---

## 14. Glossary

- **Account**: A customer record, optionally typed as residential,
  commercial, or property_manager. Commercial accounts may have sub-
  accounts (properties under management).
- **Brand voice**: The locked tone, register, and lexical preferences
  for a tenant's outbound communications.
- **Confidence marker**: A typed flag indicating the AI is uncertain
  about a specific element (part, price, urgency, account, voice).
- **Digest**: The end-of-day SMS summary delivered between 6–9pm tenant
  local.
- **Proposal**: A typed, reviewable, human-approvable representation of
  a proposed mutation (create customer, draft estimate, send invoice,
  reschedule, etc.).
- **Supervisor agent**: A cheaper second-pass classifier that reviews
  primary AI outputs for missed urgency, pricing anomalies, brand-voice
  drift, and account-routing errors.
- **Vertical pack**: A bundle of HVAC- or plumbing-specific
  terminology, taxonomy, templates, severity classifiers, and intake
  skills, loaded per tenant.
- **Vulnerability signal**: Age, weather, medical, or property-type
  context that elevates urgency in triage.
- **Wave**: A delivery phase (1–4) replacing v1's phase numbering
  (P0–P19). See §7.

---

## 15. Document history

| Version | Date | Author | Summary |
|---------|------|--------|---------|
| 1.0 | (pre-2026-05) | Product | Initial 8-phase execution catalog. |
| 2.0 | 2026-05-17 | Product | Re-framed around the AI back office strategy. Added 11 new stories (SMS approval, supervisor agent, digest, review monitoring, dropped-call recovery, vulnerability triage, correction loop, brand voice, tech status, plus two guardrails). Deferred P6, P10-001, P12, P13, P14, P15–P19. Replaced P10-002 with the digest. Architecture updated. Success metrics re-baselined on owner hours saved. |

**Next scheduled review**: After Wave 1 exit, before Wave 2 kick-off.

**Change protocol**: PRD changes require a recorded owner-decision in
`docs/decisions.md` and a paired update to `docs/strategy/day-in-the-
life.md` if the change affects the customer experience.
