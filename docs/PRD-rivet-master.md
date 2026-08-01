# Rivet — Master PRD
## Voice AI That Runs the Business

**Brand:** Rivet · **Product:** ServiceOS
**Version:** 1.0 (consolidated)
**Date:** 2026-07-12
**Owner:** Product
**Status:** Canonical positioning + interaction spec. Companion to the live `docs/PRD.md` (v2.0); this doc consolidates and supersedes the positioning sections of the archived `docs/PRD-v3.md` (see Appendix C), and supersedes the separate competitive, voice, decision, and story drafts from this cycle.
**Build-status claims code-verified 2026-07-12 against `/packages`.**

---

### Contents

| § | Section |
|---|---|
| 1 | The product in one sentence |
| 2 | Why voice is the interface |
| 3 | Customers — personas & anti-personas |
| 4 | Jobs to Be Done |
| 5 | The three voice surfaces |
| 6 | Surface 1 — The inbound voice agent |
| 7 | Surface 2 — The owner's spoken command line |
| 8 | Surface 3 — SMS, the approval rail |
| 9 | Voice-first onboarding |
| 10 | The trust layer — what makes voice safe enough to run money |
| 11 | Voice architecture & SLOs |
| 12 | Competitive positioning — Jobber & Avoca |
| 13 | Where voice is NOT yet real — the honest gap list |
| 14 | Open decisions (incl. **D-020 — voice approval**) |
| 15 | Where images fit |
| 16 | Non-goals |
| 17 | Success metrics |
| 18 | Near-term voice roadmap |
| — | **Appendix A** — Voice on-ramp stories (U6–U8) |
| — | **Appendix B** — Glossary |
| — | **Appendix C** — Sources & build-status honesty |

---

# 1. The product in one sentence

> **The owner speaks. The business runs.**
>
> Rivet is a voice AI back office for 1–3-truck trades shops. Customers call and the AI answers, qualifies, and books. The owner talks to the business — *"invoice the Martins for two hours and a capacitor," "move Thursday's Williams job to Tuesday," "did I make money on the Hernandez job?"* — and the AI turns speech into typed, approvable actions that actually write to the system of record.

**Not** a dashboard with a microphone bolted on. **Not** a chat assistant that hands work back to a human. The voice channel *is* the product; the web app is for audit, configuration, and oversight.

### The wedge, in one line

> **Jobber gives the owner better paperwork. Avoca answers the phone. Rivet does the office work — the owner speaks, it happens, and they get to stay a tradesperson.**

---

# 2. Why voice is the interface

## 2.1 The thesis: administrative debt

Skilled tradespeople rarely fail because they can't do the trade. They grind themselves down under **administrative debt** — the office work a 1–3-person shop has no one to do. The owner becomes, against their will, the *dispatcher, CSR, estimator, bookkeeper, collections agent, and marketing manager*. Only the last role they wanted was "tradesperson."

ServiceOS replaces the office manager these shops can't afford.

**Why the interface must be voice, specifically:**
- The owner's hands are in conduit, under a sink, on a roof, in gloves. **A screen requires stopping.**
- The customer calls because they want to talk. **A booking form loses them.**
- The work doesn't wait. It piles up until 10pm, or it doesn't get done at all.

## 2.2 Why now

1. Real-time voice models can hold a competent service-business conversation for well under **$1/min** in COGS.
2. Twilio + Deepgram + Stripe are mature enough for an AI to run a full money flow end-to-end.
3. The labor crisis removed the alternative. *"Hire a receptionist"* isn't an option at this size. **The AI is the receptionist, the bookkeeper, and the dispatcher.**

## 2.3 The governing test

> **"Can the owner *direct* this with a spoken sentence while driving to their next job?"**
> If no, **the feature is not complete.**
>
> **Approval is exempt by design.** Directing the work is *labor* — it must be speakable. Approving the work is *control* — it is deliberate, visual, and one tap. (See **§14 / D-020**.)

And the litmus test that kills features:

> **No feature ships that adds admin work to the owner's day.** If daily use requires opening the web app for more than ~30 seconds, it's the wrong surface.

## 2.4 The measures

- **North star:** **owner hours returned per week.** Target: **12+ hours/week** for the median pilot by week 8, baselined by time-diary at onboarding.
- **Secondary:** **time-to-cash** — days from job completion to payment received.
- **Design measure:** **leverage-per-direction** — how much the AI accomplishes per spoken instruction, *without* removing the owner's agency.

> **Market-sizing note (corrected):** the real contractor first-year failure rate is **~15–20%** (Census data), **not** the widely-cited 70% figure. That stat is debunked. It must not appear in any document, deck, or pitch.

---

# 3. Customers — personas & anti-personas

The defining trait of the ICP is not company size. It's **single-threaded admin load**: one person (or no person) doing all the office work.

**Primary ICP:** Owner-operator home-service shops — **1–3 trucks, no dedicated office staff, $200K–$1M revenue, HVAC or plumbing (V1).**

### Persona 1 — Mike Rivera (HVAC, Phoenix, 2 trucks)
38, married, two kids, wife works full-time. One employee (Carlos, cousin, tech). Revenue ~$680K. Real job title: *dispatcher, CSR, estimator, bookkeeper, collections agent, marketing manager, and HVAC tech* — only the last is what he wanted.

- **Good day with Rivet:** six overnight calls answered, four jobs booked while he slept. Estimates went out catalog-priced. Two invoices issued by *telling the app* what the job cost. The end-of-day SMS says he billed $4,200 and has $12,400 open.
- **Bad day the product must handle:** stale labor rate in a quote · hallucinated part · missed emergency · dropped call · customer games the price · tech no-show · 1-star review.

### Persona 2 — Jenna Walsh (plumbing, Cleveland, solo)
41, divorced, raising a teenager. 18 years in the trade, 3 on her own. Revenue ~$340K. **Does not want a fleet** — wants to stay solo and reclaim her life. Being single-threaded makes the AI back office *more* urgent for her, not less.

- **Good day:** 4am frozen-pipe call. AI answers, triages severity, books the first four slots. Photos of the damage become a draft estimate. **The proposals are waiting when she stops** — she approves with a thumb and dictates any edits. The invoice issues as she walks out the door.
- **Bad day:** property-manager account not recognized · MMS quote too generic · wrong labor rate on an invoice · no-show notice to the wrong customer.

### Persona 3 — The tech going independent *(top of funnel)*
The plumber or HVAC tech who just left a 500-person company. No systems, no processes, no price book. **Rivet is the first software they buy**, and it stands up the back office during onboarding. Lowest CAC, zero switching cost, digital-native. They become Mike or Jenna.

### Anti-personas — do **not** optimize for
- The dispatcher at a 12-truck shop → wants ServiceTitan.
- The franchise owner → wants brand-compliance tooling, not a back office.
- The hobbyist / side-hustle plumber → revenue doesn't justify the price.
- **The owner who wants AI fully unsupervised** → that's a different trust contract than the one we sell.

---

# 4. Jobs to Be Done

## 4.1 The master job

> *"When I go out on my own, help me run a real business without becoming a full-time office worker — so I can stay a tradesperson and still get paid, keep customers, and know where I stand."*

## 4.2 The three job dimensions

**Functional** — the work that must get done:
Answer every call and turn it into a booked job · get an accurate quote out fast · turn completed work into an invoice and then into cash · keep the schedule coherent when reality changes · know per job and per day whether money was made · keep the customer record and comms history straight.

**Emotional** — how the owner wants to feel:
**Relief** — the pile isn't growing while I'm under a sink. **Trust without babysitting** — I approve the AI's work with a glance, not re-do it. **Control** — nothing goes out in my name that I didn't OK. **Competence** — I look as organized as the big shop I left. **Freedom** — I get my evenings back.

**Social** — how the owner wants to be seen:
By customers: *"they always pick up."* By family: present, not buried in paperwork at 10pm. By peers going independent: *"here's the thing that let me do this solo."*

## 4.3 The seven operational JTBD

These are the numbered jobs every feature is graded against (referenced as `JTBD #2`, `JTBD #7` in the plan docs).

| # | Job (owner's words) | "Done" looks like | Capability | Jobber gap | Avoca gap |
|---|---|---|---|---|---|
| **1** | *"Never let a call go to voicemail."* | Every call answered, qualified, booked | Inbound voice agent → booking proposal | AI **captures**; a human still books | Answers + hands off; never reaches the system of record |
| **2** | *"Let me trust the AI without re-checking everything."* | Uncertainty surfaced, not hidden | Confidence markers + supervisor agent | No AI-write trust layer (read-mostly) | Limited trust model |
| **3** | *"Get my quotes out the same day."* | A catalog-priced estimate drafts itself from a call or a photo | Voice/MMS → draft estimate → one tap | Template editor the human fills in | Not an estimating tool |
| **4** | *"Get me paid faster."* | Job → invoice → payment link → collected, hands-off | Auto-invoice + dunning + pay link | Parity on mechanics — but human-operated | Out of scope |
| **5** | *"Tell me if I actually made money."* | Per-job P&L on demand | Per-job profit by voice | Top plan only | Out of scope |
| **6** | *"Let me stay a tradesperson."* | I run the business by speaking | Voice-first, both directions | Requires daily console operation | Phone only |
| **7** | *"Tell me where I stand without logging in."* | 30-second end-of-day summary | End-of-day SMS digest | No digest | No digest |

## 4.4 What each product actually gets *hired* to do

- **Jobber** gets hired to be **a better filing cabinet with a polished front end.** It organizes the office. The owner still operates it. Jobber *reduces* the office workload; it doesn't remove the owner from the office.
- **Avoca** gets hired to be **a receptionist.** It answers the phone. It hands the request back to a human and does nothing about quotes, invoices, collections, scheduling, or knowing the state of the business.
- **ServiceTitan** gets hired to **run a fleet's operation.** Built for 10–1000 techs with office staff. Wrong shape, wrong price.
- **Rivet** gets hired to be **the office manager.** It answers, books, quotes, invoices, chases payment, and reports — by voice, with one-tap approval. **It doesn't reduce the office job. It removes the owner from it.**

> **The job Jobber and Avoca leave un-hired:** *"do the office work for me, end to end, and let me stay in the field."* That is the entire wedge.

---

# 5. The three voice surfaces

```
┌──────────────────────────────────────────────────────────────────────┐
│ SURFACE 1 — Customer → Business   (the phone answers itself)         │
│ Customer calls → AI answers in brand voice → identifies the customer │
│ → triages urgency → checks slots → drafts a booking proposal.        │
├──────────────────────────────────────────────────────────────────────┤
│ SURFACE 2 — Owner → System   (the spoken command line for the shop)  │
│ Owner speaks → STT → intent + entity resolution → typed proposal     │
│ → one-tap approval → deterministic, audited execution.               │
├──────────────────────────────────────────────────────────────────────┤
│ SURFACE 3 — SMS   (the async approval rail — voice's partner)        │
│ When the owner can't talk: proposals arrive as <320-char one-tap     │
│ APPROVE / EDIT / REJECT. The end-of-day digest = the dashboard.      │
└──────────────────────────────────────────────────────────────────────┘
```

SMS is **not** a competing interface. It's how voice-generated work reaches an owner whose hands are full. **Voice creates; SMS confirms.**

---

# 6. Surface 1 — The inbound voice agent

**Trigger:** a customer calls the shop's number.

| Step | What happens |
|------|--------------|
| **Answer** | AI answers in the shop's brand voice: *"M&R Mechanical, how can I help you?"* |
| **Identify** | Phone number → customer match; loads history, equipment, open invoices, membership status |
| **Recognize member** | *"Hi Sarah, I see you're on our Gold plan — you have priority scheduling"* |
| **Triage emergency** | Urgency + **vulnerability signals** (age, weather, medical, property type) → fast-path escalation, skip the booking flow, patch through to the owner |
| **Classify intent** | Book service · get a quote · check an appointment · general question · complaint · B2B account |
| **Disambiguate** | *"Heating or cooling?"* / *"Is this an emergency or can we schedule a visit?"* |
| **Scope with context** | Equipment age, service history, and vertical vocabulary injected into the prompt |
| **Check slots** | Availability in tenant timezone + drive-time feasibility + conflict detection |
| **Propose** | Creates a `create_booking` proposal with date/time/tech/job details |
| **Confirm** | *"You're booked Tuesday at 2 — you'll get a text confirmation"* |
| **Recover** | Dropped call detected **< 5s** → SMS recovery to the caller **within 60s** with the partial transcript |

**Vertical behavior:** HVAC → equipment type, service history, seasonal urgency. Plumbing → severity triage (active leak > frozen-no-leak > routine). B2B → property-manager routing, sub-account association, occupied-property flag.

## The AI never negotiates

Discount demands, scope creep, *"let me speak to the manager,"* deadline threats → the AI holds the line politely in brand voice (*"Let me check with Mike on that — I'll get back to you within the hour"*), **commits to nothing**, and drafts an owner proposal with a recommendation.

**No price, discount, scope, or person-promise ever leaves the AI's mouth unapproved.** The holding line is deterministically composed from the tenant's brand voice — golden-asserted to contain no commitment.

---

# 7. Surface 2 — The owner's spoken command line

This is the differentiator no competitor has. **The owner runs the business by talking to it.**

## 7.1 How a sentence becomes a business action

```
Owner speaks (push-to-talk)
  → POST /api/voice/recordings
  → transcription (Deepgram)
  → voice-action-router
  → classifyIntent  (via the LLM gateway — never a direct provider call)
  → INTENT_TO_PROPOSAL_TYPE
  → task handler builds a typed Zod proposal
  → entity resolver   ▸ ambiguous? → voice_clarification. Never a silent guess.
  → catalog resolver  ▸ every price grounded in the tenant's catalog
  → proposal persisted; initial status set by ACTION CLASS
  → ONE-TAP HUMAN APPROVAL  (screen or SMS)
  → ProposalExecutor (5s undo + idempotency)
  → row persisted + audit event emitted
```

Two rules keep this safe rather than reckless:
- **Ambiguity produces a question, not a guess.** Two customers named Smith → a one-tap clarification, never a coin flip.
- **Every AI-drafted price is catalog-resolved before a proposal exists.** Uncatalogued lines cap confidence and cannot auto-approve.

## 7.2 The spoken-action catalog

**Voice-reachable intents** have both a speech→proposal task handler and an approval→persistence execution handler wired in production. The count moves as fast as the code ships, so this document does not hardcode it — `docs/reference/voice-action-catalog.md` is the code-pinned source of truth (a contract test fails the moment the catalog drifts from the code). As of 2026-07-12 it lists **34 speakable actions**. Below, grouped by **action class**, which decides what may *ever* execute without a tap:

### `capture` — drafts and low-risk records
*May auto-approve only under an explicit standing-instruction trust path.*

| Owner says | Becomes |
|---|---|
| *"Invoice the Johnson job — $450, capacitor plus labor"* | `draft_invoice` |
| *"Quote the Khan install, 3-ton condenser"* | `draft_estimate` |
| *"Book Carlos at the Garcia place Tuesday at 2"* | `create_appointment` |
| *"New customer, Maria Alvarez, 480-555-0102"* | `create_customer` |
| *"Open a job for Alvarez — no AC"* | `create_job` |
| *"Add a $90 contactor to the Smith invoice"* | `update_invoice` |
| *"Change the Khan quote to a 3-ton"* | `update_estimate` |
| *"Move the Garcia job to Thursday at 10"* | `reschedule_appointment` |
| *"Put Carlos on the Garcia job instead of me"* | `reassign_appointment` |
| *"Note on the Patel job — wants morning visits"* | `add_note` |
| *"Update Alvarez's phone number"* | `update_customer` |
| *"I spent $84 at Ferguson on the Miller job"* | `log_expense` |
| *"Clock 2 hours on the Patel job"* | `log_time_entry` |
| *"Convert the Greenfield lead to a customer"* | `convert_lead` |
| *"Confirm the Garcia appointment"* | `confirm_appointment` |
| *"Mark the Wagner lead lost — went with a competitor"* | `mark_lead_lost` |
| *"Add a service location for Greenfield, 12 Lakeshore"* | `add_service_location` |
| *"Add Carlos to the Garcia appointment"* | `add_crew_member` |
| *"Take Carlos off Tuesday's job"* | `remove_crew_member` |
| *"Invoice all my completed jobs from today"* | `batch_invoice` |

### `money` — **never** auto-approves. Ever.

| Owner says | Becomes |
|---|---|
| *"Issue the Garcia invoice"* | `issue_invoice` |
| *"Mark the Smith invoice paid — $200 cash"* | `record_payment` |
| *"Add a late fee to the Smith invoice"* | `apply_late_fee` |

### `comms` — **never** auto-approves. Nothing goes out in the shop's name unapproved.

| Owner says | Becomes |
|---|---|
| *"Send the Johnson invoice"* | `send_invoice` |
| *"Send the Khan estimate"* | `send_estimate` |
| *"Text the Garcia customer I'm 20 minutes late"* | `notify_delay` |
| *"Ask the Smith customer for a review"* | `request_feedback` |
| *"Send a payment reminder on the Smith invoice"* | `send_payment_reminder` |
| *"Nudge the Khan estimate"* | `send_estimate_nudge` |

### `irreversible` — **never** auto-approves.

| Owner says | Becomes |
|---|---|
| *"Cancel Tuesday's Garcia appointment"* | `cancel_appointment` |
| *"Emergency — no heat at the Hayes place, page me"* | `emergency_dispatch` |

### Read-only skills — answered aloud, no proposal, no approval

*"What's on my schedule today?"* · *"How much did I make this week?"* · *"Did I make money on the Hernandez job?"* · *"What did I charge the Smiths last time?"* · *"What's my quote acceptance rate this month?"* · *"How many hours did Carlos work?"* · *"What's on my truck?"*

### Guardrail paths — deliberately produce **no** mutation

Complaint → `add_note` + owner callback. Negotiation → owner callback with a recommendation, and nothing else.

## 7.3 The catalog is code-checked, not prose

A contract test (`packages/api/test/ai/voice-action-catalog.contract.test.ts`) imports `SUPPORTED_INTENTS`, `INTENT_TO_PROPOSAL_TYPE`, the execution-registry keys, and `actionClassForProposalType`, and **fails when the published catalog drifts from the code.**

The lesson was learned the hard way: `remaining-features.md` rotted — it listed `emergency_dispatch` as missing after it had shipped. **A static doc always drifts. A test doesn't.**

---

# 8. Surface 3 — SMS, the approval rail

Proposals render to a **< 320-character SMS** with one-tap **APPROVE / EDIT / REJECT**, so the owner can act from a thumb in a truck.

- **APPROVE** → executes deterministically, idempotently, with an audit event and a **5-second undo** window.
- **EDIT** → the owner replies — including by **voice dictation** into the phone's native keyboard: *"make it 1.5 hours."* The AI revises and re-presents.
- **REJECT** → nothing happens. Logged as signal for the correction loop.
- **APPROVE ALL** → a single batch reply against the end-of-day digest.

> **Note the distinction that matters (see D-020):** voice-dictated *SMS edits* are already in scope and already work. They are **not** recorder-channel voice approval, which the code hard-refuses. **Tap to approve, speak to edit.**

## The end-of-day digest *is* the dashboard

One SMS, **6–9pm** in tenant time, the whole business in 30 seconds:
- Jobs completed — count + revenue billed + revenue collected
- Quotes sent — count + pipeline value
- Overdue follow-ups sent + outcomes
- Tomorrow's schedule
- **"What I wasn't sure about today"** — the confidence markers that fired, and what the owner decided
- **"What I learned today"** — corrections applied to prior outputs
- Outstanding AR

**No real-time charts. No morning log-in.**

---

# 9. Voice-first onboarding

The top-of-funnel persona is a tech who just left a 500-person company with no systems, no processes, no price book. Rivet is the first software they buy — and **onboarding is the first proof that voice runs the business.**

**Intended experience:** *"I run Bob's HVAC, open 8 to 5 weekdays, I charge $120 an hour, it's me and my cousin Carlos…"* — a **multi-turn conversation (10–15 exchanges)** with progressive clarification, extracting business profile, hours, vertical pack, pricing seed, and team into `onboarding_*` proposals that write real tenant config on approval. **Forms remain the fallback and the edit surface — never the primary path.**

**Target:** new shop → active AI back office in **< 48 hours**.

> ⚠️ **Reality check (§13, Gap 4):** the extraction engine exists but runs as a **single batch over a monologue** — no turn-by-turn loop, no session persistence. The shipped V2 onboarding is a **form wizard**, which is exactly the UX we pitch *against*. This headline differentiator **is not yet real.**

---

# 10. The trust layer — what makes voice safe enough to run money

Voice without a trust layer is a liability. This is the architecture that lets an AI write to the system of record.

## 10.1 Directed assistant — not autonomous agent, not dashboard

**Removing the owner's administrative *labor* is the goal. Removing the owner's *agency* is the failure mode.**

Every AI action on the system of record is a **typed, Zod-validated proposal** requiring **one human approval**. This was a hard-won correction: an earlier framing conflated "remove the owner's labor" with "remove the owner from the loop." **Do not reintroduce it.**

> **The trust contract in one line: the AI proposes; the human disposes; the system remembers.**

## 10.2 The proposal card

- **Type** — the mutation class, Zod-validated.
- **Plain-language summary** — in the shop's brand voice.
- **Payload** — customer, time, tech, catalog-priced line items, totals in **integer cents**.
- **Confidence markers** — *"I wasn't sure about: [item]."* Never a percentage on every line.
- **Per-line pricing source** — `catalog` / `ambiguous` / `uncatalogued`. Ambiguous lines get a **one-tap picker** that patches the draft; it never auto-executes.
- **Controls** — APPROVE / EDIT / REJECT. Plus expiry.

**Lifecycle:**
```
draft → ready_for_review → (supervisor pass) → delivered (UI / SMS)
   ├─ APPROVE → deterministic execution (idempotent · audited · 5s undo · rollback-safe)
   ├─ EDIT    → owner dictates a change → revised proposal → approve
   ├─ REJECT  → discarded, logged as signal
   └─ EXPIRE  → surfaced in the digest as pending
```

## 10.3 Standing instructions — the keystone

The owner sets durable, plain-language policies **once**, and the AI executes within them thereafter. This is what turns *"an assistant you have to micromanage"* into *"an office manager who knows how you run things"* — and it is where **leverage-per-direction** comes from.

- **Brand voice** — register, opening line, sign-off, banned phrases, persona name. Captured in onboarding, then **locked**, and validated on **every** outbound utterance by the Brand-Voice Validator.
- Working hours, job buffers, escalation thresholds.
- What may auto-approve (capture class only — never money, comms, or irreversible).

## 10.4 The supervisor agent

A cheaper second-pass classifier reviews **every** booking, quote, and invoice *before* it reaches the owner or the customer — re-scoring missed urgency, pricing anomalies, brand-voice drift, and account-routing errors within a **< 60s** budget.

**Advisory and downgrade-only.** It can flag or lower confidence; it can **never** promote something to auto-approval.

## 10.5 The correction loop

Every owner edit is a learning event. Edits become **structured lessons** applied forward; the digest reports *"what I learned today."*

This is the moat that compounds **per tenant** — the system converges on *this shop's* prices, voice, and preferences. Jobber has no equivalent because Jobber's AI never wrote anything to correct.

## 10.6 Designed for the bad day, not the demo

| Failure | The mechanism that catches it |
|---|---|
| Stale labor rate in a quote | Catalog resolver + approval queue |
| Hallucinated part | Confidence marker fires |
| Missed emergency | Supervisor flags; vulnerability + urgency → owner patch-through |
| Dropped call | Detected < 5s → SMS recovery < 60s with partial transcript |
| Customer games the price | Negotiation guardrail refuses; owner proposal with a recommendation |
| Tech no-show | SMS "OUT" → cascade reschedule proposals, one tap each |
| Two customers named Smith | `voice_clarification` — a question, never a guess |
| 1-star review | AI-drafted public response + private apology, in the queue |

## 10.7 Non-negotiable invariants

Integer cents, never floats · UTC stored / tenant-local rendered · every row carries `tenant_id` with **RLS FORCE** · every mutation emits an audit event · all AI calls route through the **LLM gateway** only · proposals are typed Zod contracts, human-approved, **never auto-executed** · AI prices are **catalog-resolved** before a proposal exists · high-stakes outputs pass the **supervisor**.

**A workflow that breaks one of these is misaligned by definition. Any fix that would break one is the wrong fix — find another way.**

---

# 11. Voice architecture & SLOs

```
INBOUND (customer)                          OWNER (back office)
Twilio Media Streams                        Push-to-talk capture
  → Deepgram streaming STT (<300ms)           → Deepgram / Whisper transcription
  → Intake & Triage                           → voice-action-router
     intent · vulnerability · severity        → classifyIntent
     B2B recognizer · dropped-call recovery
                    ↓                                    ↓
        Conversation layer  (threads · transcripts · entity resolution · history)
                    ↓
        AI Orchestration  (context assembly · vertical-pack routing · task selection)
                    ↓
        LLM Gateway  —  Tier 1 classify (fast/cheap) · Tier 2 propose · Tier 3 estimate
                    ↓
        Catalog Resolver  (every price grounded; uncatalogued caps confidence at 0.85)
                    ↓
        ══════ PROPOSAL ENGINE — THE TRUST BOUNDARY ══════
        Zod contracts · confidence markers · Brand-Voice Validator
        negotiation guardrails · expiry
                    ↓
        Supervisor Agent  (<60s · advisory · downgrade-only)
                    ↓
        SMS Approval Transport  (<320 chars · one-tap · voice-dictated edits)
                    ↓  approved only
        Deterministic Execution  (idempotent · audited · 5s undo · rollback-safe)
                    ↓
        Postgres  (RLS FORCE, tenant-scoped)
                    ↓
        Reporting & Learning  (AI runs · edit deltas · correction loop · digest)
                    ↓
        Reputation Layer  (Google polling · review classifier · draft response)
```

**Stack:** Twilio Media Streams · Deepgram (Nova-3 streaming) · ElevenLabs TTS · tiered LLM gateway · PgQueue durable queue · Postgres with RLS · Clerk auth.

## Voice SLOs

| Metric | Target |
|---|---|
| Streaming STT latency | **< 300 ms** |
| Time to first audio (TTFA), inbound call | **< 800 ms** — the bar that makes us competitive with Avoca; far better than Gather polling |
| Spoken booking → `create_booking` proposal | **< 5 s** — synthetic voice smoke test, **gates deploy** |
| p95 first-STT under load | **< 2,000 ms with zero dropped connections** |
| Concurrent voice sessions | **1,000** — dual SLO: real-time WebSocket **and** HTTP/API |
| Dropped-call SMS recovery (P95) | **< 60 s** |
| Supervisor pass | **< 60 s** |

---

# 12. Competitive positioning — Jobber & Avoca

## 12.1 Jobber — the primary head-to-head

**What it is.** The dominant horizontal FSM platform for 1–50-tech shops. Deep, battle-tested: CRM, client hub, scheduling, dispatch, quoting, invoicing, payments, memberships, QuickBooks, native mobile.

**Its AI.** Assistant features bolted *on top of* the system — Copilot and an AI Receptionist. The AI Receptionist **captures** a phone request; **a human still books it.** The AI is **read-mostly**: it advises and drafts, but the human operates the console for every decision. It does not write to the system of record.

**Where Jobber genuinely wins — say it out loud:**
- Native iOS/Android (we're PWA → native on roadmap)
- Deep, mature client hub (full book/approve/pay/history)
- Battle-tested QuickBooks sync
- Route optimization (we do drive-time feasibility, not optimization)
- Consumer financing (Wisetack), tip capture, tap-to-pay

**Where Jobber structurally loses for our ICP:**
- **It's paperwork, not labor.** The owner must open the app and operate it. For someone whose hands are in conduit, that's the wrong surface.
- **Its AI cannot write the system of record.** Jobber's AI sits *on top of* the system and hands off. **Ours *is* the system.** Jobber cannot bolt this on — it requires a proposal/approval trust layer at the core.
- **Voice is not the interface.** Jobber's AI is a chat assistant *in the app*. We are voice-first in **both** directions.
- **No end-of-day digest.** No "the dashboard is a 6–9pm SMS" model.

> **Structural ceiling:** Jobber's architecture assumes a human operator at a console. Ours assumes the human is in the field and the AI runs the office under supervision. Those are different products — and the second is not a feature Jobber can ship incrementally.

## 12.2 Avoca — the AI-receptionist add-on

**What it is.** A front-desk AI add-on. Its job is to **answer the phone** and capture the caller's request.

**Its AI.** Answers calls, **read-mostly**, then **hands off**. It is a phone layer with no system behind it: it does not book into a system of record, draft estimates, issue invoices, chase payments, or report on the business. Its trust/safety model is limited.

**Where Avoca is relevant.** It sets the bar on **inbound-call latency and answering quality**. Our real-time stack (Media Streams → Deepgram, sub-800ms TTFA) exists *specifically* to be competitive with Avoca on the call experience — while going far beyond it, because for us **the call ends in a booked job**, not a hand-off.

**Where Avoca loses.** It does **exactly one** of the seven jobs (JTBD #1). It answers the phone and stops. The other six — trust, quoting, getting paid, knowing profit, staying out of the office, knowing where you stand — are **entirely un-served**.

## 12.3 The canonical scorecard

| | **Jobber** | **ServiceTitan** | **Avoca** | **Rivet / ServiceOS** |
|---|---|---|---|---|
| **Target** | 1–50 techs | 10–1000 techs | Front-desk add-on | **1–3 techs, owner-operator** |
| **AI role** | Assistant features (Copilot, AI Receptionist) | Bolt-on | Answers phone, read-mostly | **Runs the back office; writes via proposals** |
| **Owner's office workload** | Reduced (still daily app use) | Shifted to office staff | Calls only | **Eliminated — voice + SMS, never a console** |
| **Trust / safety model** | None | None | Limited | **Typed proposals + supervisor + undo + audit** |
| **Phone answering** | AI captures, human books | Partial | AI answers, hands off | **AI answers, proposes booking, owner approves** |
| **Voice as primary interface** | No (chat assistant in app) | No | No | **Yes — both directions** |
| **Equipment history** | No | Yes (enterprise) | No | **Yes (HVAC differentiator)** |
| **Per-job profit by voice** | Top plan only | Yes | No | **Yes (roadmap)** |
| **Native mobile** | iOS/Android | iOS/Android | n/a | PWA → native (roadmap) |
| **End-of-day digest** | No | No | No | **Yes — the dashboard** |
| **AI writes to system of record** | No | No | No | **Yes — the core architecture** |
| **Price, 2-person shop** | $79–249/mo | Prohibitive | Add-on cost | **See §14 / D-022 — unresolved** |

## 12.4 Feature parity map — Rivet vs. Jobber

> Status must be re-verified against `/packages` before any prospect sees this. See **Appendix C**.

| Workflow | Jobber | Rivet | Rivet edge |
|---|---|---|---|
| Phone answering | AI Receptionist captures; human books | AI answers, classifies, drafts booking proposal; one tap | Loop closed without a human touch |
| Inbound booking | AI captures, human dispatches | AI proposes booking from the call | No dispatcher needed |
| Online booking | Public widget | Token-free public link | Parity |
| Scheduling | Manual + AI suggestions | Voice-driven, drive-time feasibility, conflict detection | *"Schedule Carlos Thursday at 2"* = done |
| Dispatch / assignment | Manual drag-drop board | Voice assignment → proposal | Spoken, not clicked |
| Tech ETA texts | Auto on departure | Location → ETA → brand-voice SMS | Parity |
| Tech "I'm out" | Manual call to dispatcher | SMS "OUT" → cascade reschedule proposals | No dispatcher to call |
| Estimating | Template editor | Voice-drafted, catalog-priced | No screen needed |
| Tiered estimates | Yes | Yes | Parity |
| **MMS-to-quote** | No | Photo → AI analysis → draft estimate | **Differentiator** (🔧 partial) |
| Auto-invoice on completion | Yes | Yes | Parity |
| **Voice-issued invoice** | No | *"Invoice the Martins…"* → catalog-priced proposal | **Differentiator** |
| Customer pay portal | Yes (Client Hub) | Yes (token-gated link) | Parity |
| ACH payments | Yes | Yes | Parity (🔧 partial) |
| Memberships | Full engine | Auto-renew + member pricing + priority booking | Parity target |
| Client hub | Full (book/approve/pay/history) | Lightweight (approve + pay, no login) | **Jobber leads** — by our design |
| QuickBooks sync | Deep | Basic (roadmap) | **Jobber leads** |
| Route optimization | Yes | Drive-time feasibility | **Jobber leads** |
| Mobile app | Native | PWA (native roadmap) | **Jobber leads** |
| **End-of-day digest** | No | Yes — the dashboard | **Differentiator** |
| **AI writes to system of record** | No | Yes — typed proposals + approval + audit | **Core differentiator** |
| **Trust / approval layer** | None | Proposal + undo + audit on every AI action | **Core differentiator** |
| **Correction loop** | No | Owner edits → system learns → digest reports | **Differentiator** |

## 12.5 Position by vertical

| Vertical | Incumbent | Their AI | Our edge |
|---|---|---|---|
| **HVAC** *(wedge)* | ServiceTitan, Jobber, Housecall Pro | Chat assistant; Jobber AI Receptionist (hand-off) | AI runs the back office; equipment history on every call |
| **Plumbing** | Jobber, Housecall Pro, ServiceTitan | Same | MMS-to-quote; severity triage from the call |
| Electrical | Jobber, ServiceTitan | Minimal | First AI-first platform w/ permit surfacing |
| Painting | Jobber, Workiz, Estimate Rocket | Minimal | Photo-first quoting; multi-day voice scheduling |
| Pest control | PestPac, ServSuite, FieldRoutes | **None** | First voice AI answering + booking routes |
| Handyman | Jobber, Housecall Pro | Minimal | T&M voice invoicing |

**The pattern:** every adjacent vertical has either entrenched vertical software with **zero** AI voice capability, or horizontal software (Jobber) that goes wide but not deep. **We go deep on AI-first voice back office in every vertical we enter.**

---

# 13. Where voice is NOT yet real — the honest gap list

> **Build-status discipline is non-negotiable.** The docs lag the code. Every gap below is code-verified, and every one is a hole in the voice story we are selling.

### 🔴 Gap 1 — The narrative says she approves by voice. The code hard-refuses it.
`approve_proposal` / `reject_proposal` / `edit_proposal` are **hard-refused on the recorder channel** (RV-071/225). Voice approval is explicitly **post-launch** per the locked voice-interaction scope: **launch approves by screen or SMS tap.** Meanwhile the PRD promises it in at least four places.

**→ Resolved in §14 / D-020. Until decided: do not demo or deck approval-by-voice.**

### ✅ Gap 2 — CLOSED — *"It looked like it worked but nothing saved."* (historical)
Several execution handlers **degraded to a synthetic-id passthrough** when a dependency was unwired: they returned `{ success: true }` and **persisted nothing.**

**Status: closed.** `draft_invoice` and `create_job` — the two most valuable spoken actions — now have Docker-gated integration proof that approve → execute → persist → audit actually happens against real Postgres: `packages/api/test/integration/draft-invoice-execution.test.ts` (U2) and `packages/api/test/integration/create-job-execution.test.ts` (U3). A boot-time wiring guard, `assertVoiceHandlersWired` (`packages/api/src/proposals/execution/wiring-assertions.ts`, called at boot in `app.ts`), fails startup loudly if any voice-reachable handler is degraded while a Postgres pool is configured (U5, unit-tested).

**Remaining sliver — closing on this branch (U4):** appointment audit emission had a production bug (`auditRepo` was not passed on the execution path), fixed in this branch, alongside a new `create_customer` real-Postgres integration proof and new customer/appointment audit assertions. Once merged, all four create paths (invoice, job, appointment, customer) carry the same persistence + audit proof.

### ✅ Gap 3 — CLOSED — Sentences the owner would obviously say that used to get silently skipped. (historical)
These had proposal types, Zod schemas, and execution handlers **already built** — but no classifier intent and no `INTENT_TO_PROPOSAL_TYPE` entry, so **the transcript was dropped on the floor**:

*"Add Carlos to the Garcia appointment"* · *"Take Carlos off Tuesday's job"* · *"Invoice all my completed jobs from today"* · *"Add a late fee to the Smith invoice"* · *"Send a payment reminder on the Smith invoice"* · *"Nudge the Khan estimate"*

**Status: closed (U6/U7/U8).** All six on-ramp intents — `add_crew_member`, `remove_crew_member`, `batch_invoice`, `apply_late_fee`, `send_payment_reminder`, `send_estimate_nudge` — are now in `SUPPORTED_INTENTS`, mapped in `INTENT_TO_PROPOSAL_TYPE`, with Zod contracts, task handlers, and registered execution handlers (action classes: `batch_invoice`/crew = capture, nudge/reminder = comms, late fee = money). See **Appendix A** for story-level detail — the on-ramp gap it describes is now historical. The one open thread from this unit, the payment-reminder double-send risk, is being closed on this same branch (see Appendix A.4).

### 🟠 Gap 4 — Conversational onboarding isn't conversational.
The orchestrator and extractors exist but run as a **single batch over a monologue**: no turn-by-turn clarification, no session persistence. The shipped V2 onboarding is a **form wizard**. This is the difference between *"we have onboarding code"* and *"we can demo the differentiator."*

### 🟡 Gap 5 — Two inbound voice paths, only one of which books.
The **certified** path that actually books an appointment is **Twilio Gather**. **VAPI does not book appointments yet.** Media Streams is the real-time path that hits the sub-800ms bar. **Sales and engineering must not describe these as one thing.** → §14 / D-021.

### 🟡 Gap 6 — Launch voice UX is push-to-talk.
Live mic, streaming STT on the web client, and barge-in are **post-launch**. Wake-word / always-listening is an explicit later opt-in. **The demo must reflect push-to-talk.**

### 🟡 Gap 7 — Voice actions needing real builds, not on-ramps.
- `assign_technician` (AI-ranked dispatch by voice) — needs a **new** proposal type + handler (P25).
- `add_equipment` / equipment registry by voice — **no type or handler exists** (P24).

---

# 14. Open decisions

## D-020 — Voice approval of proposals
**Status:** 🟡 **PROPOSED — HELD FOR JOSH'S REVIEW.** Reverses or ratifies a locked scope decision and touches the approval gate.
**Blocks:** demos, decks, GTM copy, the Jenna narrative.

### The contradiction
The code hard-refuses recorder-channel voice approval (RV-071/225; launch scope = tap). Those claims were never in this master PRD's own text — they live in the now-**archived** `docs/archive/2026-07-cleanup/docs/PRD-v3.md`, which promised it in four places:

| Location (in the archived PRD-v3.md) | The claim |
|---|---|
| §1 | *"…approves with one tap **or one word**"* |
| §2 (Jenna) | *"She **approves by voice** while driving."* |
| §4 (Direction 1) | *"owner approves **via SMS or voice**"* |
| §4 (capability test) | *"Can the owner do this with a spoken sentence…"* — sweeps in approval |

This was systemic, not a typo. **It was our most quotable line, and it did not work.** The live `docs/PRD.md` (v2.0) does not contain the "one word" claim, and this master PRD already applies the amended governing test — see **§2.3** above — so the contradiction described here is preserved as historical context for the decision, not a live inconsistency in this document.

### First, a distinction that dissolves half the problem
**Voice-dictated SMS replies are already in scope and are NOT recorder-channel voice approval.** The owner gets the approval SMS, taps EDIT, and dictates the change using their **phone's native keyboard mic**. That's an OS feature — it never touches RV-071/225.

So half the Jenna narrative is **already true today: tap to approve, speak to edit.** What's genuinely unavailable is hands-free, *eyes-free* assent.

### The question underneath: is approval labor, or is it control?

The thesis is precise: *remove the owner's **labor**, never their **agency**.* Approval **is** the agency act — the one moment the trust boundary exists to protect. Four consequences, and they cut against the marketing line:

1. **A tap is a better assent primitive than a word.** Unambiguous. Cannot be triggered by a passenger, a radio, a customer on speakerphone, or an ambient *"yeah, approve that."* Prompt injection against the voice agent is already a standing red-team target — audio-triggered approval is a **new attack surface on the money flow.**
2. **Approving by voice means approving something you only *heard*.** A `draft_invoice` you never saw is materially weaker consent than a card you read. For `issue_invoice` or `record_payment` — money class — that's a liability, not a feature.
3. **"Approves while driving" is a workflow we arguably shouldn't promise.** We'd be marketing a hands-on-the-wheel, money-moving consent flow. If she's driving, she can't safely tap *or* look. The honest answer: **the proposals wait for the next driveway.** The AI's job is to make sure nothing is *lost* while she drives.
4. **It isn't north-star-moving.** Approval budget is **< 15/day**. Tap-vs-word is **~15 seconds a day**. The north star is *hours returned per week*. **This feature returns none of them.**

### Options

**A — Amend the narrative; keep the tap.** *(Docs + copy only. Zero build. Zero new attack surface. Honest to the code.)* Cost: loses "one word."

**B — Build full recorder-channel voice approval.** Reverses RV-071/225. Opens audio-triggered execution on money-class actions; consent without a visual; a real safety surface on the highest-consequence path we own — for 15 seconds/day. **Not recommended.**

**C — Voice approval by action class, with read-back.** Spoken approval **only for `capture`-class** (reversible, no money moves, nothing leaves the shop); **tap required forever** for money/comms/irreversible. TTS reads the summary back → owner confirms → 5s undo still applies. Behind a flag.
- ✅ Reuses machinery that **already exists** — `actionClassForProposalType` + `decideInitialStatus` already encode this exact risk gradient.
- ✅ Does **not** violate D-004: voice approval *is* human approval. It changes the **transport** of assent, not its existence. (D-004 is an *invariant*; the launch scope is a *schedule*. Only the latter would be reversed.)

### 🎯 Recommendation

> **Adopt Option A now. Hold Option C as a post-launch enhancement decided on its own merits — not to rescue a marketing line.**

**And fix the thing that manufactured the contradiction.** The governing test as written — *"Can the owner **do** this with a spoken sentence?"* — applied to every domain, **demands voice approval by construction.** Change one word:

> **"Can the owner *direct* this with a spoken sentence while driving to their next job?"**
> **Approval is exempt by design.** Directing the work is labor — it must be speakable. Approving the work is control — deliberate, visual, one tap.

That single word makes the PRD internally consistent, keeps the voice thesis intact, and **states the trust model more sharply than the original did.** (Already applied in §2.3 of this document.)

### If Option A is adopted — consequences
- **Docs:** the amendment described here (§1 "one tap," Jenna → *"The proposals are waiting when she stops. She approves them with a thumb, and dictates any edits,"* Direction 1 → "one-tap SMS"; capability test → per above) applied to the archived `docs/archive/2026-07-cleanup/docs/PRD-v3.md`'s positioning language and is now carried forward as this master PRD's canonical text. `voice-interaction-scope.md` **unchanged — it was right.**
- **Copy:** kill "one word" everywhere. Replacement, stronger because it's true: **"You talk. It works. You tap once."**
- **Demo:** spoken instruction → proposal card → **one tap** → executed. Never stage an approval-by-voice moment.
- **Code: none.** The code was already correct. **The documents drifted.**

### If Option C is chosen — hard preconditions, none optional
1. **U5 (boot-time wiring guard) ships first** — voice-approving a degraded handler would say "approved ✓" and persist nothing.
2. **Action-class enforcement as a test, not a comment** — money/comms/irreversible **unreachable** from the voice-approval path, at any trust tier.
3. **Two-turn read-back confirm.** Single-utterance approval is unacceptable on any class.
4. **Anti-spoof** — speaker verification or a session-bound challenge.
5. **Flagged, default off**, blocked at the router *and* re-asserted at the executor.

### ☐ Decision
- [ ] **A** — amend the narrative, keep the tap, fix the governing test. *(Recommended.)*
- [ ] **B** — build full voice approval. *(Not recommended.)*
- [ ] **C** — capture-class voice approval with read-back, post-launch, flagged.

---

## D-021 — Canonical inbound voice path
**Gather** books appointments and is certified. **VAPI** does not book yet. **Media Streams** hits the sub-800ms bar. **Pick one; retire the divergence.** Sales and engineering must not describe these as a single thing.

## D-022 — Pricing *(blocks GTM)*
The archived `docs/archive/2026-07-cleanup/docs/PRD-v3.md` says **$300–500/mo** (full back office). A **$99/mo** figure also exists in the record. **Unresolved.** Competitive anchor: Jobber $79–249/mo for a 2-person shop; Avoca is an add-on *on top of* whatever runs the office.

*Settled already:* 0.5% platform processing fee atop Stripe; tiered model routing (~70% cheap-tier) solves both COGS and resilience.

---

# 15. Where images fit

**Photos are context. Voice is the command.**

The pattern is **"snap and say"**: the tech photographs the leak and says *"quote this — looks like a slab leak under the kitchen."* The image is **evidence attached to a spoken instruction** — never a separate app the owner has to operate.

Three layers, and conflating them will burn the roadmap:

| Layer | Reality |
|---|---|
| **1. Capture** | **Easy.** The PWA opens the rear camera today via file-input capture. The presigned-upload + attachment pipeline **already exists**. No native required. |
| **2. Vision** | **The actual blocker.** The LLM gateway is **text-only** (`LLMMessage.content: string`). Nothing intelligent happens with a photo until the content contract accepts image parts. **This is what gates MMS-to-quote** (🔧 partial — photo ingest only; image→estimate not built). |
| **3. Native (Capacitor)** | **A separate decision.** It buys the **offline photo/voice queue** for basements and crawlspaces — *not* the ability to capture. Do **not** bundle it with "we need image capture." |

**Sequence:** PWA capture → gateway multimodal → photo-to-estimate → *(optionally)* native offline queue.

> **The trap:** treating "capture images" as one feature. Capture is the easy 20%. The vision pipeline is the 80% that differentiates us from Jobber and Avoca.

---

# 16. Non-goals

The won't-build list is as load-bearing as the build list — it's what keeps us from drifting into a worse Jobber.

- Not a dashboard the owner opens every morning.
- Not a dispatch console for a 10-person ops team.
- Not an enterprise FSM platform (that's ServiceTitan — different ICP).
- Not a marketing-automation platform / campaign builder / A-B tester. *(Bounded, approval-gated re-engagement only.)*
- Not a tax, payroll, or legal tool.
- Not a customer portal as a daily destination — **the client hub is a link, not a login.**
- **Not an unsupervised agent.** The owner who wants AI with no approval gate is buying a different trust contract than the one we sell.
- **No feature ships that adds admin work to the owner's day.**

**Drift guard for every proposed feature:** *Does this return owner hours, and is it reachable by a spoken sentence?* If not, it's the wrong feature or the wrong surface.

---

# 17. Success metrics

**North star:** owner hours returned per week — **12+ for the median pilot at week 8.** Time-diary baseline at onboarding; re-measured at weeks 4 and 8.

## Voice-specific

| Metric | Target |
|---|---|
| Calls answered during work hours | 40% → **100%** |
| Spoken-action success (utterance → correct proposal) | **> 90%** |
| Spoken action → persisted row + audit | **100%** *(currently unproven — Gap 2)* |
| Owner SMS approvals/day | **< 15** (sustainable) |
| Approval median latency (business hours) | **< 10 min** |
| Estimate-proposal approval rate | **≥ 70%** *(clean, no-edit: ≥ 30%)* |
| Invoice-proposal approval rate | **≥ 75%** |
| Supervisor false-positive / false-negative | **< 5% / < 2%** |
| Vulnerability-triage correct escalation | **> 95%** |
| Digest delivery in-window | **> 99%** |

## Business

Quotes drafted within 4h of intake: 30% → **>90%** · Invoices sent within 24h of completion: 50% → **>90%** · Time-to-cash: 14–21 days → **< 10** · Paying customers: **5 → 25** (3 → 6 months) · Week-4 retention: 80% → 90% · NPS **> 50** by month 6.

---

# 18. Near-term voice roadmap

```
CERTIFY FIRST ─────────────────────────────────────────────
  U1  ✅ Code-checked voice action catalog + drift test
  U2  ✅ draft_invoice: approve → execute → persist → audit  (integration)
  U3  ✅ create_job: same                                    (integration)
  U4  🟡 Audit-emission assertions on all three create paths — appointment
        audit bug fixed + create_customer Pg proof landing on this branch
  U5  ✅ Boot-time execution-wiring guard  (was a hard blocker for U8 — now clear)

THEN BUILD ────────────────────────────────────────────────
  U6  ✅ Crew add/remove          capture
  U7  ✅ Batch-invoice            capture
  U8  ✅ Collections (late fee, reminder, nudge)   money/comms

THEN THE DIFFERENTIATORS ──────────────────────────────────
  F-A  Gateway multimodal (image parts)     ← long pole
  E1   Photo → draft estimate (MMS-to-quote)
  —    Multi-turn conversational onboarding (Gap 4)
```

**Current state:** U1, U2, U3, U5, U6, U7, and U8 are shipped and code-verified as of 2026-07-12. U4's remaining sliver — appointment/customer audit assertions and the `create_customer` real-Postgres proof — is closing on this same branch, alongside the payment-reminder double-send dedup (Appendix A.4). Remaining work after this branch merges: the differentiators — gateway multimodal (image parts, the long pole for MMS-to-quote), photo → draft estimate, and multi-turn conversational onboarding (Gap 4).

---

# Appendix A — Voice on-ramp stories (U6–U8)

> ✅ **Status (2026-07-12): all three units are shipped.** U6 (crew add/remove), U7 (batch-invoice), and U8 (collections: late fee, payment reminder, estimate nudge) are all in production — all six intents are in `SUPPORTED_INTENTS`, mapped in `INTENT_TO_PROPOSAL_TYPE`, with Zod contracts, task handlers, and registered execution handlers. The **"Intent (missing)"** column in the table below is **historical** — it describes the pre-ship gap, not current state. The A.4 double-send mitigations (dedup against the `invoice_dunning_events` ledger + a draft-time confidence marker) are being implemented on this same branch. A feature flag for the two comms on-ramps was judged **unnecessary**: `comms`-class proposals never auto-approve regardless of any flag, so the flag would only have been a purely protective, belt-and-suspenders measure over a gate that already holds. The section body below is kept for rationale and build history.

**Parent plan:** `docs/plans/2026-06-14-001-feat-voice-action-pipeline-audit-and-gap-buildout-plan.md` · Requirement **R5**
**Scope:** 6 proposal types · 5 utterance families · 3 units · **front-half only**

## The gap, stated precisely

| Utterance | Intent *(missing)* | ProposalType *(**exists**)* | Class | Handler *(**exists**)* |
|---|---|---|---|---|
| *"Add Carlos to the Garcia appointment"* | `add_crew_member` | `add_crew_member` | capture | ✅ |
| *"Take Carlos off Tuesday's job"* | `remove_crew_member` | `remove_crew_member` | capture | ✅ |
| *"Invoice all my completed jobs from today"* | `batch_invoice` | `batch_invoice` | capture | `BatchInvoiceExecutionHandler` |
| *"Add a late fee to the Smith invoice"* | `apply_late_fee` | `apply_late_fee` | **money** | ✅ |
| *"Send a payment reminder on the Smith invoice"* | `send_payment_reminder` | `send_payment_reminder` | **comms** | ✅ |
| *"Nudge the Khan estimate"* | `send_estimate_nudge` | `send_estimate_nudge` | **comms** | ✅ |

**No new migrations. No new handlers. No new proposal types.** The build is: classifier intent + entity extraction + `INTENT_TO_PROPOSAL_TYPE` + routing tests.

## A.0 Preconditions — do not dispatch U8 before these

> **U1 → U5 → U6–U8.** The parent plan sequences "certify, then build" deliberately.

- [ ] **U1** — code-checked catalog (`docs/reference/voice-action-catalog.md` + drift test). Each unit moves its rows **B → A**.
- [ ] **U5** — boot-time wiring guard (`assertVoiceHandlersWired`). **Hard blocker for U8.** A spoken `apply_late_fee` that reports success and writes no row is the **worst failure this product can produce.** Never ship a money-class on-ramp onto an unguarded path.

**U6 and U7 (capture-class) may proceed in parallel with U5. U8 may not.**

## A.1 Cross-cutting requirements

**Invariants:** integer cents (reuse `shared/billing-engine.ts`) · `tenant_id` + RLS unchanged · audit event on every mutation · classification via the **LLM gateway** only · proposals stay typed, human-approved, **never auto-executed**.

**Entity resolution is non-negotiable.** Every free-text reference routes through the entity resolver. **Ambiguity emits `voice_clarification` — never a silent guess.**

**Test mandate:** voice/AI → handler tests with **mocked gateway + repos**. Front-half only, no DB → **no integration tests required.** Tests ship in the same commit; `tsc --project tsconfig.build.json` stays green.

**⚠️ Classifier prompt budget — the real risk.** The system prompt is already **~826 lines**. Adding six intents risks **accuracy regressions on the existing 25.** Mandatory: run the intent-classifier eval set **before and after** each unit; add per-intent unit cases; **prefer deterministic phrase shortcuts** where the router supports them. *A regression on `create_invoice` to buy `send_estimate_nudge` is a net loss.*

## A.2 — U6 · Crew add / remove  `capture`

**Goal.** *"Add Carlos to the Garcia appointment"* / *"Take Carlos off Tuesday's job"* → `add_crew_member` / `remove_crew_member`.

**Files**
- `packages/api/src/ai/orchestration/intent-classifier.ts` — add both to `SUPPORTED_INTENTS` + prompt; extract `{ technicianReference, appointmentReference }`.
- `packages/api/src/workers/voice-action-router.ts` — add both to `INTENT_TO_PROPOSAL_TYPE`; route both references through the entity resolver.
- `packages/api/test/ai/orchestration/intent-classifier.test.ts` *(extend)*
- `packages/api/test/workers/voice-action-router.crew.test.ts` *(new)*
- `docs/reference/voice-action-catalog.md` — rows **B → A**.

**Approach.** Reuse the **`reassign_appointment`** wiring end-to-end — the closest analog (same reference shape, same `annotateResolvedEntities` usage, same routing). Class stays `capture`. Nothing else changes.

**Tests.** Happy (both refs extracted) · route → correct capture-class initial status · **ambiguity** (two techs named Carlos → `voice_clarification`, **no proposal**) · removal symmetry · U1 drift test green.

## A.3 — U7 · Batch-invoice completed jobs  `capture`

**Goal.** *"Invoice all my completed jobs from today"* → a `batch_invoice` proposal that **fans out individual `draft_invoice` proposals on approval**.

**Files**
- `intent-classifier.ts` — add `batch_invoice` + prompt; extract the selection window (e.g. `{ scope: 'completed_today' }`).
- `voice-action-router.ts` — map intent → `batch_invoice`.
- `test/ai/orchestration/intent-classifier.test.ts` *(extend)* · `test/workers/voice-action-router.batch-invoice.test.ts` *(new)*
- `docs/reference/voice-action-catalog.md` — row **B → A**.

**Approach.** Front-half only. `BatchInvoiceExecutionHandler` **already fans out** via `proposalRepo`.

**Why capture-class, not money-class** *(state it so nobody "fixes" it later)*: `batch_invoice` **mints drafts and moves no money.** Each fanned-out `draft_invoice` remains **individually approvable**, and `issue_invoice` (money) still needs its own tap. The owner approves *"draft these,"* not *"bill these."* **One sentence, N reviewable drafts, zero money moved.**

**Tests.** Happy (scope extracted) · route → **not auto-approved** · **empty scope** → clear *"nothing to invoice"*, **no empty-proposal spam** · drift green.

**Open question:** final `scope` shape — `'completed_today'` vs. explicit job list. **Confirm against the existing `batchInvoicePayloadSchema`**; don't invent one.

## A.4 — U8 · Collections  `money` + `comms`

> 🔴 **Gated on U5. Money + comms class. Isolate for Josh's review before merge, per the repo pause gate.**

**Goal.** *"Add a late fee to the Smith invoice"* → `apply_late_fee` **(money)** · *"Send a payment reminder on the Smith invoice"* → `send_payment_reminder` **(comms)** · *"Nudge the Khan estimate"* → `send_estimate_nudge` **(comms)**

**Files**
- `intent-classifier.ts` — add all three + prompt; extract `{ invoiceReference }` / `{ estimateReference }`.
- `voice-action-router.ts` — three `INTENT_TO_PROPOSAL_TYPE` entries; resolve refs via the entity resolver.
- `test/ai/orchestration/intent-classifier.test.ts` *(extend)* · `test/workers/voice-action-router.collections.test.ts` *(new)*
- `docs/reference/voice-action-catalog.md` — three rows **B → A**.

**The action-class assertion is a test, not a comment.** `apply_late_fee` **must** resolve as `money`; both sends **must** resolve as `comms` — so `decideInitialStatus` keeps all three **out of auto-approve at any trust tier.** Assert via `actionClassForProposalType` + `decideInitialStatus`. **Pin it; don't assume it.**

### ⚠️ The sharp risk: double-send

`send_payment_reminder` and `send_estimate_nudge` are **already fired autonomously** by the existing dunning / estimate-reminder sweeps. A spoken on-ramp creates a real collision: the owner says *"send a payment reminder on the Smith invoice"* while the sweep is about to send one anyway. **The customer gets chased twice** — precisely the *"the AI made me look unprofessional"* failure the trust model exists to prevent.

**Required mitigations — decide before build:**
1. **Dedup against the existing idempotency ledger** the sweeps already use (one nudge per invoice per dunning window), so a spoken reminder and a swept reminder **cannot both land**.
2. **Surface the collision on the proposal card** — *"A reminder already went out 2 days ago"* — as a confidence marker, so the owner approves with the facts.
3. **Feature-flag the two comms on-ramps** for staged rollout. *(Recommended.)*

`apply_late_fee` has no sweep collision, but it **moves money**: ships in **its own commit**, held for review.

**Status (2026-07-12):** both mitigations 1 and 2 are being implemented on this branch: an execution-time 72h cooldown guard plus a record-first ledger write (`manual:<proposalId>` step keys) against `invoice_dunning_events`, sweep-side deferral so the autonomous sweep backs off when a manual send has just gone out, and a draft-time confidence marker ("a reminder already went out N days ago"). Mitigation 3 (the feature flag) was judged unnecessary — see the Appendix A status banner above — because the `comms` action class already blocks auto-approval regardless of flag state. `send_estimate_nudge` was already safe before this branch: it shares `dispatchEstimateNudge`'s guard with a 48h cooldown. `apply_late_fee` already has ledger idempotency, proven by `packages/api/test/integration/late-fee-idempotency.test.ts`.

**Tests.** Classify each of three · route → **non-auto-approved** status (asserted) · **ambiguity** → `voice_clarification` · **not-found** → clarification, **never a silent guess** · **double-send** → deduped or surfaced, never silently duplicated · drift green.

## A.5 What this does NOT include

- **Voice approve / reject / edit** — hard-refused (RV-071/225), post-launch. See **D-020**.
- **`assign_technician` by voice** — needs a **new** proposal type + handler (P25). Not an on-ramp.
- **`add_equipment` by voice** — **no type or handler exists** (P24).
- **Auto-invoice on job completion** — a worker trigger, not a spoken action (P20 / C1).
- **Persistence certification** — U2/U3 shipped: `draft_invoice` and `create_job` are proven via real-Postgres integration tests (see §13 Gap 2, ✅ closed). U4's audit-assertion sliver (appointment/customer) is closing on this branch. This work was separate from, and more urgent than, these on-ramps.

---

# Appendix B — Glossary

| Term | Definition |
|---|---|
| **Proposal** | A typed, reviewable, human-approvable representation of a mutation. **Nothing executes without one.** |
| **Action class** | `capture` / `money` / `comms` / `irreversible`. Money, comms, and irreversible **never** auto-approve. |
| **Confidence marker** | A typed flag on something the AI was unsure about. Surfaced as *"I wasn't sure about…"* — never a per-line percentage. |
| **`voice_clarification`** | The proposal type emitted when an entity reference is ambiguous. **A question, never a guess.** |
| **Standing instruction** | A durable owner policy the AI executes within — brand voice, hours, escalation thresholds, auto-approve permissions. **The keystone.** |
| **Supervisor agent** | Second-pass reviewer of high-stakes output. < 60s. **Advisory and downgrade-only.** |
| **Correction loop** | Owner edits → structured lessons → applied forward. Reported in the digest. |
| **Catalog resolver** | Grounds every AI-drafted price in the tenant's catalog. Uncatalogued lines cap confidence at 0.85. |
| **Vertical pack** | Trade-specific terminology, severity classifiers, intake skills, and estimate templates, loaded per tenant. |
| **Brand-Voice Validator** | Validates every outbound utterance against the tenant's locked brand voice. |
| **Leverage-per-direction** | How much the AI accomplishes per spoken instruction, **without removing owner agency.** The primary measure of product quality. |
| **The dashboard** | The 6–9pm end-of-day SMS digest. **There is no console.** |

---

# Appendix C — Sources & build-status honesty

## The rule

> **Never propagate a "built" claim without verifying it against `/packages`.** The docs lag the code. This competitive scorecard is a **positioning artifact** — before it goes in front of a prospect or an investor, verify each row against the code and **mark unverifiable rows honestly.**

## Known status corrections (2026-06-14 reconciliation)

**Downgraded** — claimed built, only partial:
- **MMS-to-quote** — photo ingest only; image→estimate not built (gateway is text-only).
- **ACH payments** — card + payment links live; ACH not configured/exercised.
- **B2B account recognition** — binary residential/B2B flag only; no property-manager type, sub-accounts, or routing.

**Upgraded** — shipped ahead of roadmap status: memberships · auto-invoice on completion · dunning/overdue · late fees · estimate follow-up · auto-pay/saved-card.

A later competitive audit found **44 of 48 claims fully built**, with three concrete shipping gaps — **conversational onboarding loop, delayed post-job thank-you SMS, painting vertical pack** — and one documentation-only mismatch.

## Sources

`docs/archive/2026-07-cleanup/docs/PRD-v3.md` (archived; voice-first architecture, locked decisions, feature map, personas, parity map, competitive summary) · `docs/strategy/day-in-the-life.md` (personas, bad-day failure modes) · `docs/competitive-gap-analysis.md` · the **voice-action-pipeline audit plan** 2026-06-14 (the 25-intent capability matrix, RV-071/225 approval refusal, persistence gaps, unspeakable actions) · the **voice-first-onboarding plan** (dormant orchestrator, route-aware VoiceBar) · the **PRD-gap-closure plans** (multi-turn onboarding gap, gateway multimodal) · the **appointment-verification plan** (Gather vs. VAPI) · the **launch-quality-bar plan** (voice smoke test, load SLOs) · the **CRM/comms/multi-location parity plan** · `docs/launch/voice-interaction-scope.md` (PTT at launch; voice approval post-launch) · `docs/decisions.md` (D-003 cents, D-004 no auto-execute, D-005 gateway, D-011 SMS one-tap, D-012 status reconciliation).
